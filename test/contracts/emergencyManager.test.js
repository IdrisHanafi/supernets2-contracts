const { expect } = require('chai');
const { ethers, upgrades } = require('hardhat');

describe('Emergency mode test', () => {
    let deployer;
    let trustedAggregator;
    let trustedSequencer;
    let admin;

    let verifierContract;
    let supernets2dot0BridgeContract;
    let supernets2dot0Contract;
    let maticTokenContract;
    let supernets2dot0GlobalExitRoot;

    const maticTokenName = 'Matic Token';
    const maticTokenSymbol = 'MATIC';
    const maticTokenInitialBalance = ethers.utils.parseEther('20000000');

    const genesisRoot = '0x0000000000000000000000000000000000000000000000000000000000000001';

    const networkIDMainnet = 0;
    const urlSequencer = 'http://zkevm-json-rpc:8123';
    const chainID = 1000;
    const networkName = 'zkevm';
    const version = '0.0.1';
    const pendingStateTimeoutDefault = 10;
    const trustedAggregatorTimeoutDefault = 10;
    let firstDeployment = true;

    beforeEach('Deploy contract', async () => {
        upgrades.silenceWarnings();

        // load signers
        [deployer, trustedAggregator, trustedSequencer, admin] = await ethers.getSigners();

        // deploy mock verifier
        const VerifierRollupHelperFactory = await ethers.getContractFactory(
            'VerifierRollupHelperMock',
        );
        verifierContract = await VerifierRollupHelperFactory.deploy();

        // deploy MATIC
        const maticTokenFactory = await ethers.getContractFactory('ERC20PermitMock');
        maticTokenContract = await maticTokenFactory.deploy(
            maticTokenName,
            maticTokenSymbol,
            deployer.address,
            maticTokenInitialBalance,
        );
        await maticTokenContract.deployed();

        /*
         * deploy global exit root manager
         * In order to not have trouble with nonce deploy first proxy admin
         */
        await upgrades.deployProxyAdmin();
        if ((await upgrades.admin.getInstance()).address !== '0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0') {
            firstDeployment = false;
        }

        const nonceProxyBridge = Number((await ethers.provider.getTransactionCount(deployer.address))) + (firstDeployment ? 3 : 2);
        const nonceProxyZkevm = nonceProxyBridge + 2; // Always have to redeploy impl since the supernets2dot0GlobalExitRoot address changes

        const precalculateBridgeAddress = ethers.utils.getContractAddress({ from: deployer.address, nonce: nonceProxyBridge });
        const precalculateZkevmAddress = ethers.utils.getContractAddress({ from: deployer.address, nonce: nonceProxyZkevm });
        firstDeployment = false;

        const Supernets2dot0GlobalExitRootFactory = await ethers.getContractFactory('Supernets2dot0GlobalExitRoot');
        supernets2dot0GlobalExitRoot = await upgrades.deployProxy(Supernets2dot0GlobalExitRootFactory, [], {
            initializer: false,
            constructorArgs: [precalculateZkevmAddress, precalculateBridgeAddress],
            unsafeAllow: ['constructor', 'state-variable-immutable'],
        });

        // deploy Supernets2dot0Bridge
        const supernets2dot0BridgeFactory = await ethers.getContractFactory('Supernets2dot0Bridge');
        supernets2dot0BridgeContract = await upgrades.deployProxy(supernets2dot0BridgeFactory, [], { initializer: false });

        // deploy Supernets2dot0Mock
        const Supernets2dot0Factory = await ethers.getContractFactory('Supernets2dot0Mock');
        supernets2dot0Contract = await upgrades.deployProxy(Supernets2dot0Factory, [], {
            initializer: false,
            constructorArgs: [
                supernets2dot0GlobalExitRoot.address,
                maticTokenContract.address,
                verifierContract.address,
                supernets2dot0BridgeContract.address,
                chainID,
                0,
            ],
            unsafeAllow: ['constructor', 'state-variable-immutable'],
        });

        expect(precalculateBridgeAddress).to.be.equal(supernets2dot0BridgeContract.address);
        expect(precalculateZkevmAddress).to.be.equal(supernets2dot0Contract.address);

        await supernets2dot0BridgeContract.initialize(networkIDMainnet, supernets2dot0GlobalExitRoot.address, supernets2dot0Contract.address);
        await supernets2dot0Contract.initialize(
            {
                admin: admin.address,
                trustedSequencer: trustedSequencer.address,
                pendingStateTimeout: pendingStateTimeoutDefault,
                trustedAggregator: trustedAggregator.address,
                trustedAggregatorTimeout: trustedAggregatorTimeoutDefault,
            },
            genesisRoot,
            urlSequencer,
            networkName,
            version,
        );

        // fund sequencer address with Matic tokens
        await maticTokenContract.transfer(trustedSequencer.address, ethers.utils.parseEther('1000'));

        // Activate force batches
        await expect(
            supernets2dot0Contract.connect(admin).activateForceBatches(),
        ).to.emit(supernets2dot0Contract, 'ActivateForceBatches');
    });

    it('should activate emergency mode', async () => {
        // Check isEmergencyState
        expect(await supernets2dot0Contract.isEmergencyState()).to.be.equal(false);
        expect(await supernets2dot0BridgeContract.isEmergencyState()).to.be.equal(false);

        await expect(supernets2dot0Contract.connect(admin).deactivateEmergencyState())
            .to.be.revertedWith('OnlyEmergencyState');

        // Set isEmergencyState
        await expect(supernets2dot0Contract.connect(admin).activateEmergencyState(1))
            .to.be.revertedWith('BatchNotSequencedOrNotSequenceEnd');

        await expect(supernets2dot0BridgeContract.connect(deployer).activateEmergencyState())
            .to.be.revertedWith('OnlySupernets2dot0');

        await expect(supernets2dot0Contract.activateEmergencyState(0))
            .to.emit(supernets2dot0Contract, 'EmergencyStateActivated')
            .to.emit(supernets2dot0BridgeContract, 'EmergencyStateActivated');

        expect(await supernets2dot0Contract.isEmergencyState()).to.be.equal(true);
        expect(await supernets2dot0BridgeContract.isEmergencyState()).to.be.equal(true);

        // Once in emergency state no sequenceBatches/forceBatches can be done
        const l2txData = '0x123456';
        const maticAmount = await supernets2dot0Contract.batchFee();
        const currentTimestamp = (await ethers.provider.getBlock()).timestamp;

        const sequence = {
            transactions: l2txData,
            globalExitRoot: ethers.constants.HashZero,
            timestamp: ethers.BigNumber.from(currentTimestamp),
            minForcedTimestamp: 0,
        };

        // revert because emergency state
        await expect(supernets2dot0Contract.sequenceBatches([sequence], deployer.address))
            .to.be.revertedWith('OnlyNotEmergencyState');

        // revert because emergency state
        await expect(supernets2dot0Contract.sequenceForceBatches([sequence]))
            .to.be.revertedWith('OnlyNotEmergencyState');

        // revert because emergency state
        await expect(supernets2dot0Contract.forceBatch(l2txData, maticAmount))
            .to.be.revertedWith('OnlyNotEmergencyState');

        // revert because emergency state
        await expect(supernets2dot0Contract.consolidatePendingState(0))
            .to.be.revertedWith('OnlyNotEmergencyState');

        // trustedAggregator forge the batch
        const newLocalExitRoot = '0x0000000000000000000000000000000000000000000000000000000000000001';
        const newStateRoot = '0x0000000000000000000000000000000000000000000000000000000000000001';
        const numBatch = (await supernets2dot0Contract.lastVerifiedBatch()).toNumber() + 1;
        const zkProofFFlonk = '0x';
        const pendingStateNum = 0;

        await expect(
            supernets2dot0Contract.connect(trustedAggregator).verifyBatches(
                pendingStateNum,
                numBatch - 1,
                numBatch,
                newLocalExitRoot,
                newStateRoot,
                zkProofFFlonk,
            ),
        ).to.be.revertedWith('OnlyNotEmergencyState');

        // Check Supernets2dot0Bridge no Supernets2dot0Bridge is in emergency state also
        const tokenAddress = ethers.constants.AddressZero;
        const amount = ethers.utils.parseEther('10');
        const destinationNetwork = 1;
        const destinationAddress = deployer.address;

        await expect(supernets2dot0BridgeContract.bridgeAsset(
            destinationNetwork,
            destinationAddress,
            amount,
            tokenAddress,
            true,
            '0x',
        )).to.be.revertedWith('OnlyNotEmergencyState');

        await expect(supernets2dot0BridgeContract.bridgeMessage(
            destinationNetwork,
            destinationAddress,
            true,
            '0x',
        )).to.be.revertedWith('OnlyNotEmergencyState');

        const proof = Array(32).fill(ethers.constants.HashZero);
        const index = 0;
        const root = ethers.constants.HashZero;

        await expect(supernets2dot0BridgeContract.claimAsset(
            proof,
            index,
            root,
            root,
            0,
            tokenAddress,
            destinationNetwork,
            destinationAddress,
            amount,
            '0x',
        )).to.be.revertedWith('OnlyNotEmergencyState');

        await expect(supernets2dot0BridgeContract.claimMessage(
            proof,
            index,
            root,
            root,
            0,
            tokenAddress,
            destinationNetwork,
            destinationAddress,
            amount,
            '0x',
        )).to.be.revertedWith('OnlyNotEmergencyState');

        // Emergency council should deactivate emergency mode
        await expect(supernets2dot0Contract.activateEmergencyState(0))
            .to.be.revertedWith('OnlyNotEmergencyState');

        await expect(supernets2dot0BridgeContract.connect(deployer).deactivateEmergencyState())
            .to.be.revertedWith('OnlySupernets2dot0');

        await expect(supernets2dot0Contract.deactivateEmergencyState())
            .to.be.revertedWith('OnlyAdmin');

        await expect(supernets2dot0Contract.connect(admin).deactivateEmergencyState())
            .to.emit(supernets2dot0Contract, 'EmergencyStateDeactivated')
            .to.emit(supernets2dot0BridgeContract, 'EmergencyStateDeactivated');

        // Check isEmergencyState
        expect(await supernets2dot0Contract.isEmergencyState()).to.be.equal(false);
        expect(await supernets2dot0BridgeContract.isEmergencyState()).to.be.equal(false);

        /*
         * Continue normal flow
         * Approve tokens
         */
        await expect(
            maticTokenContract.connect(trustedSequencer).approve(supernets2dot0Contract.address, maticAmount),
        ).to.emit(maticTokenContract, 'Approval');

        const lastBatchSequenced = await supernets2dot0Contract.lastBatchSequenced();
        // Sequence Batches
        await expect(supernets2dot0Contract.connect(trustedSequencer).sequenceBatches([sequence], trustedSequencer.address))
            .to.emit(supernets2dot0Contract, 'SequenceBatches')
            .withArgs(lastBatchSequenced + 1);

        // trustedAggregator forge the batch
        const initialAggregatorMatic = await maticTokenContract.balanceOf(
            trustedAggregator.address,
        );
        await ethers.provider.send('evm_increaseTime', [trustedAggregatorTimeoutDefault]); // evm_setNextBlockTimestamp

        // Verify batch
        await expect(
            supernets2dot0Contract.connect(trustedAggregator).verifyBatches(
                pendingStateNum,
                numBatch - 1,
                numBatch,
                newLocalExitRoot,
                newStateRoot,
                zkProofFFlonk,
            ),
        ).to.emit(supernets2dot0Contract, 'VerifyBatches')
            .withArgs(numBatch, newStateRoot, trustedAggregator.address);

        const finalAggregatorMatic = await maticTokenContract.balanceOf(
            trustedAggregator.address,
        );
        expect(finalAggregatorMatic).to.equal(
            ethers.BigNumber.from(initialAggregatorMatic).add(ethers.BigNumber.from(maticAmount)),
        );

        // Finally enter in emergency mode again proving distinc state
        const finalPendingStateNum = 1;

        await expect(
            supernets2dot0Contract.connect(trustedAggregator).proveNonDeterministicPendingState(
                pendingStateNum,
                finalPendingStateNum,
                numBatch - 1,
                numBatch - 1,
                newLocalExitRoot,
                newStateRoot,
                zkProofFFlonk,
            ),
        ).to.be.revertedWith('FinalNumBatchDoesNotMatchPendingState');

        await expect(
            supernets2dot0Contract.connect(trustedAggregator).proveNonDeterministicPendingState(
                pendingStateNum,
                finalPendingStateNum,
                numBatch - 1,
                numBatch + 1,
                newLocalExitRoot,
                newStateRoot,
                zkProofFFlonk,
            ),
        ).to.be.revertedWith('FinalNumBatchDoesNotMatchPendingState');

        const newStateRootDistinct = '0x0000000000000000000000000000000000000000000000000000000000000002';

        await expect(
            supernets2dot0Contract.proveNonDeterministicPendingState(
                pendingStateNum,
                finalPendingStateNum,
                numBatch - 1,
                numBatch,
                newLocalExitRoot,
                newStateRootDistinct,
                zkProofFFlonk,
            ),
        ).to.emit(supernets2dot0Contract, 'ProveNonDeterministicPendingState').withArgs(newStateRoot, newStateRootDistinct)
            .to.emit(supernets2dot0Contract, 'EmergencyStateActivated')
            .to.emit(supernets2dot0BridgeContract, 'EmergencyStateActivated');

        // Check emergency state is active
        expect(await supernets2dot0Contract.isEmergencyState()).to.be.equal(true);
        expect(await supernets2dot0BridgeContract.isEmergencyState()).to.be.equal(true);
    });
});
