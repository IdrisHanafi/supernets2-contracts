/* eslint-disable no-await-in-loop */

const { expect } = require('chai');
const { ethers, upgrades } = require('hardhat');
const { Scalar } = require('ffjavascript');

const { contractUtils } = require('@0xpolygonhermez/zkevm-commonjs');

const { generateSolidityInputs } = contractUtils;

const { calculateSnarkInput, calculateBatchHashData, calculateAccInputHash } = contractUtils;

const proofJson = require('./test-inputs/proof.json');
const input = require('./test-inputs/public.json');
const inputJson = require('./test-inputs/input.json');

describe('Real flow test', () => {
    let verifierContract;
    let maticTokenContract;
    let PolygonZkEVMBridgeContract;
    let supernets2Contract;
    let PolygonZkEVMGlobalExitRoot;
    let supernets2DataCommitteeContract;
    let deployer;
    let trustedSequencer;
    let trustedAggregator;
    let admin;

    const maticTokenName = 'Matic Token';
    const maticTokenSymbol = 'MATIC';
    const maticTokenInitialBalance = ethers.utils.parseEther('20000000');

    const genesisRoot = inputJson.oldStateRoot;

    const networkIDMainnet = 0;

    const urlSequencer = 'http://supernets2-json-rpc:8123';
    const { chainID } = inputJson;
    const networkName = 'supernets2';
    const version = '0.0.1';
    const forkID = 0;
    const pendingStateTimeoutDefault = 10;
    const trustedAggregatorTimeoutDefault = 10;
    let firstDeployment = true;

    beforeEach('Deploy contract', async () => {
        upgrades.silenceWarnings();

        // load signers
        [deployer, trustedAggregator, admin] = await ethers.getSigners();

        // Could be different address teorically but for now it's fine
        const trustedSequencerAddress = inputJson.singleBatchData[0].sequencerAddr;
        await ethers.provider.send('hardhat_impersonateAccount', [trustedSequencerAddress]);
        trustedSequencer = await ethers.getSigner(trustedSequencerAddress);
        await deployer.sendTransaction({
            to: trustedSequencerAddress,
            value: ethers.utils.parseEther('4'),
        });

        // deploy mock verifier
        const VerifierRollupHelperFactory = await ethers.getContractFactory(
            'FflonkVerifier',
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
        const nonceProxyCommittee = nonceProxyBridge + (firstDeployment ? 2 : 1);
        // Always have to redeploy impl since the PolygonZkEVMGlobalExitRoot address changes
        const nonceProxySupernets2 = nonceProxyCommittee + 2;

        const precalculateBridgeAddress = ethers.utils.getContractAddress({ from: deployer.address, nonce: nonceProxyBridge });
        const precalculateCommitteeAddress = ethers.utils.getContractAddress({ from: deployer.address, nonce: nonceProxyCommittee });
        const precalculateSupernets2Address = ethers.utils.getContractAddress({ from: deployer.address, nonce: nonceProxySupernets2 });
        firstDeployment = false;

        const PolygonZkEVMGlobalExitRootFactory = await ethers.getContractFactory('PolygonZkEVMGlobalExitRootMock');
        PolygonZkEVMGlobalExitRoot = await upgrades.deployProxy(PolygonZkEVMGlobalExitRootFactory, [], {
            initializer: false,
            constructorArgs: [precalculateSupernets2Address, precalculateBridgeAddress],
            unsafeAllow: ['constructor', 'state-variable-immutable'],
        });

        // deploy PolygonZkEVMBridge
        const PolygonZkEVMBridgeFactory = await ethers.getContractFactory('PolygonZkEVMBridge');
        PolygonZkEVMBridgeContract = await upgrades.deployProxy(PolygonZkEVMBridgeFactory, [], { initializer: false });

        // deploy Supernets2DataCommittee
        const supernets2DataCommitteeFactory = await ethers.getContractFactory('Supernets2DataCommittee');
        supernets2DataCommitteeContract = await upgrades.deployProxy(
            supernets2DataCommitteeFactory,
            [],
            { initializer: false },
        );

        // deploy Supernets2Mock
        const Supernets2Factory = await ethers.getContractFactory('Supernets2Mock');
        supernets2Contract = await upgrades.deployProxy(Supernets2Factory, [], {
            initializer: false,
            constructorArgs: [
                PolygonZkEVMGlobalExitRoot.address,
                maticTokenContract.address,
                verifierContract.address,
                PolygonZkEVMBridgeContract.address,
                supernets2DataCommitteeContract.address,
                chainID,
                0,
            ],
            unsafeAllow: ['constructor', 'state-variable-immutable'],
        });

        expect(precalculateBridgeAddress).to.be.equal(PolygonZkEVMBridgeContract.address);
        expect(precalculateCommitteeAddress).to.be.equal(supernets2DataCommitteeContract.address);
        expect(precalculateSupernets2Address).to.be.equal(supernets2Contract.address);

        await PolygonZkEVMBridgeContract.initialize(networkIDMainnet, PolygonZkEVMGlobalExitRoot.address, supernets2Contract.address);
        await supernets2Contract.initialize(
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
    });

    it('Test real prover', async () => {
        const batchesData = inputJson.singleBatchData;
        const batchesNum = batchesData.length;

        // Approve tokens
        const maticAmount = await supernets2Contract.batchFee();
        await expect(
            maticTokenContract.connect(trustedSequencer).approve(supernets2Contract.address, maticAmount.mul(batchesNum)),
        ).to.emit(maticTokenContract, 'Approval');

        // prepare Supernets2Mock
        await supernets2Contract.setVerifiedBatch(inputJson.oldNumBatch);
        await supernets2Contract.setSequencedBatch(inputJson.oldNumBatch);
        const lastTimestamp = batchesData[batchesNum - 1].timestamp;
        await ethers.provider.send('evm_setNextBlockTimestamp', [lastTimestamp]);

        for (let i = 0; i < batchesNum; i++) {
            // set timestamp for the sendBatch call
            const currentBatchData = batchesData[i];

            const currentSequence = {
                transactions: currentBatchData.batchL2Data,
                globalExitRoot: currentBatchData.globalExitRoot,
                timestamp: currentBatchData.timestamp,
                minForcedTimestamp: 0,
            };

            const batchAccInputHashJs = calculateAccInputHash(
                currentBatchData.oldAccInputHash,
                calculateBatchHashData(currentBatchData.batchL2Data),
                currentBatchData.globalExitRoot,
                currentBatchData.timestamp,
                currentBatchData.sequencerAddr, // fix
            );
            expect(batchAccInputHashJs).to.be.eq(currentBatchData.newAccInputHash);

            // prapare globalExitRoot
            const randomTimestamp = 1001;
            const { globalExitRoot } = batchesData[0];
            await PolygonZkEVMGlobalExitRoot.setGlobalExitRoot(globalExitRoot, randomTimestamp);

            const lastBatchSequenced = await supernets2Contract.lastBatchSequenced();

            // check trusted sequencer
            const trustedSequencerAddress = inputJson.singleBatchData[i].sequencerAddr;
            if (trustedSequencer.address !== trustedSequencerAddress) {
                await supernets2Contract.connect(admin).setTrustedSequencer(trustedSequencerAddress);
                await ethers.provider.send('hardhat_impersonateAccount', [trustedSequencerAddress]);
                trustedSequencer = await ethers.getSigner(trustedSequencerAddress);
                await deployer.sendTransaction({
                    to: trustedSequencerAddress,
                    value: ethers.utils.parseEther('4'),
                });
                await expect(
                    maticTokenContract.connect(trustedSequencer).approve(supernets2Contract.address, maticAmount.mul(batchesNum)),
                ).to.emit(maticTokenContract, 'Approval');
                await maticTokenContract.transfer(trustedSequencer.address, ethers.utils.parseEther('100'));
            }

            // Sequence Batches
            await expect(supernets2Contract.connect(trustedSequencer).sequenceBatches([currentSequence], trustedSequencer.address, []))
                .to.emit(supernets2Contract, 'SequenceBatches')
                .withArgs(Number(lastBatchSequenced) + 1);
        }

        // Set state and exit root
        await supernets2Contract.setStateRoot(inputJson.oldStateRoot, inputJson.oldNumBatch);

        const { aggregatorAddress } = inputJson;
        await ethers.provider.send('hardhat_impersonateAccount', [aggregatorAddress]);
        const aggregator = await ethers.getSigner(aggregatorAddress);
        await deployer.sendTransaction({
            to: aggregatorAddress,
            value: ethers.utils.parseEther('4'),
        });
        await supernets2Contract.connect(admin).setTrustedAggregator(aggregatorAddress);

        const batchAccInputHash = (await supernets2Contract.sequencedBatches(inputJson.newNumBatch)).accInputHash;
        expect(batchAccInputHash).to.be.equal(inputJson.newAccInputHash);

        const proof = generateSolidityInputs(proofJson);

        // Verify snark input
        const circuitInputStarkJS = await calculateSnarkInput(
            inputJson.oldStateRoot,
            inputJson.newStateRoot,
            inputJson.newLocalExitRoot,
            inputJson.oldAccInputHash,
            inputJson.newAccInputHash,
            inputJson.oldNumBatch,
            inputJson.newNumBatch,
            inputJson.chainID,
            inputJson.aggregatorAddress,
            forkID,
        );

        expect(circuitInputStarkJS).to.be.eq(Scalar.e(input[0]));

        // aggregator forge the batch
        const { newLocalExitRoot } = inputJson;
        const { newStateRoot } = inputJson;
        const { oldNumBatch } = inputJson;
        const { newNumBatch } = inputJson;
        const pendingStateNum = 0;
        // Verify batch

        await expect(
            supernets2Contract.connect(aggregator).verifyBatchesTrustedAggregator(
                pendingStateNum,
                oldNumBatch,
                newNumBatch,
                newLocalExitRoot,
                newStateRoot,
                '0x',
            ),
        ).to.be.revertedWith('InvalidProof');
        await expect(
            supernets2Contract.connect(aggregator).verifyBatchesTrustedAggregator(
                pendingStateNum,
                oldNumBatch,
                newNumBatch,
                newLocalExitRoot,
                newStateRoot,
                proof,
            ),
        ).to.emit(supernets2Contract, 'VerifyBatchesTrustedAggregator')
            .withArgs(newNumBatch, newStateRoot, aggregator.address);
    });
});
