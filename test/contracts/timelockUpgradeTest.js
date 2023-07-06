const { expect } = require('chai');
const { ethers, upgrades } = require('hardhat');

// OZ test functions
function genOperation(target, value, data, predecessor, salt) {
    const id = ethers.utils.solidityKeccak256([
        'address',
        'uint256',
        'bytes',
        'uint256',
        'bytes32',
    ], [
        target,
        value,
        data,
        predecessor,
        salt,
    ]);
    return {
        id, target, value, data, predecessor, salt,
    };
}

describe('Supernets2', () => {
    let deployer;
    let trustedAggregator;
    let trustedSequencer;
    let admin;

    let timelockContract;
    let verifierContract;
    let supernets2BridgeContract;
    let supernets2Contract;
    let supernets2DataCommitteeContract;
    let maticTokenContract;
    let supernets2GlobalExitRoot;

    const maticTokenName = 'Matic Token';
    const maticTokenSymbol = 'MATIC';
    const maticTokenInitialBalance = ethers.utils.parseEther('20000000');

    const genesisRoot = '0x0000000000000000000000000000000000000000000000000000000000000001';

    const networkIDMainnet = 0;

    const urlSequencer = 'http://supernets2-json-rpc:8123';
    const chainID = 1000;
    const networkName = 'supernets2';
    const version = '0.0.1';
    const pendingStateTimeoutDefault = 10;
    const trustedAggregatorTimeoutDefault = 10;
    let firstDeployment = true;

    const minDelay = 60 * 60; // 1 hout
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
        const nonceProxyCommittee = nonceProxyBridge + (firstDeployment ? 2 : 1);
        // Always have to redeploy impl since the supernets2GlobalExitRoot address changes
        const nonceProxySupernets2 = nonceProxyCommittee + 2;

        const precalculateBridgeAddress = ethers.utils.getContractAddress({ from: deployer.address, nonce: nonceProxyBridge });
        const precalculateCommitteeAddress = ethers.utils.getContractAddress({ from: deployer.address, nonce: nonceProxyCommittee });
        const precalculateSupernets2Address = ethers.utils.getContractAddress({ from: deployer.address, nonce: nonceProxySupernets2 });
        firstDeployment = false;

        const Supernets2GlobalExitRootFactory = await ethers.getContractFactory('Supernets2GlobalExitRoot');
        supernets2GlobalExitRoot = await upgrades.deployProxy(Supernets2GlobalExitRootFactory, [], {
            initializer: false,
            constructorArgs: [precalculateSupernets2Address, precalculateBridgeAddress],
            unsafeAllow: ['constructor', 'state-variable-immutable'],
        });

        // deploy Supernets2Bridge
        const supernets2BridgeFactory = await ethers.getContractFactory('Supernets2Bridge');
        supernets2BridgeContract = await upgrades.deployProxy(supernets2BridgeFactory, [], { initializer: false });

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
                supernets2GlobalExitRoot.address,
                maticTokenContract.address,
                verifierContract.address,
                supernets2BridgeContract.address,
                supernets2DataCommitteeContract.address,
                chainID,
                0,
            ],
            unsafeAllow: ['constructor', 'state-variable-immutable'],
        });

        expect(precalculateBridgeAddress).to.be.equal(supernets2BridgeContract.address);
        expect(precalculateCommitteeAddress).to.be.equal(supernets2DataCommitteeContract.address);
        expect(precalculateSupernets2Address).to.be.equal(supernets2Contract.address);

        await supernets2BridgeContract.initialize(networkIDMainnet, supernets2GlobalExitRoot.address, supernets2Contract.address);
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

        const proposers = [deployer.address];
        const executors = [deployer.address];
        const adminAddress = deployer.address;

        const timelockContractFactory = await ethers.getContractFactory('Supernets2Timelock');
        timelockContract = await timelockContractFactory.deploy(minDelay, proposers, executors, adminAddress, supernets2Contract.address);
        await timelockContract.deployed();
    });

    it('Should upgrade brdige correctly', async () => {
        // Upgrade the contract
        const supernets2BridgeFactoryV2 = await ethers.getContractFactory('Supernets2BridgeMock');
        const supernets2BridgeContractV2 = supernets2BridgeFactoryV2.attach(supernets2BridgeContract.address);

        // Check that is the v0 contract
        await expect(supernets2BridgeContractV2.maxEtherBridge()).to.be.reverted;

        // Upgrade the contract
        await upgrades.upgradeProxy(supernets2BridgeContract.address, supernets2BridgeFactoryV2);

        await expect(await supernets2BridgeContractV2.maxEtherBridge()).to.be.equal(0);
    });

    it('Should transferOwnership of the proxyAdmin to the timelock', async () => {
        // Upgrade the contract
        const supernets2BridgeFactoryV2 = await ethers.getContractFactory('Supernets2BridgeMock');
        const supernets2BridgeContractV2 = supernets2BridgeFactoryV2.attach(supernets2BridgeContract.address);

        // Check that is the v0 contract
        await expect(supernets2BridgeContractV2.maxEtherBridge()).to.be.reverted;

        // Transfer ownership to timelock
        await upgrades.admin.transferProxyAdminOwnership(timelockContract.address);

        // Can't upgrade the contract since it does not have the ownership
        await expect(upgrades.upgradeProxy(supernets2BridgeContract.address, supernets2BridgeFactoryV2))
            .to.be.reverted;

        const implBridgeV2Address = await upgrades.prepareUpgrade(supernets2BridgeContract.address, supernets2BridgeFactoryV2);
        const proxyAdmin = await upgrades.admin.getInstance();

        // Use timelock
        const operation = genOperation(
            proxyAdmin.address,
            0,
            proxyAdmin.interface.encodeFunctionData(
                'upgrade',
                [supernets2BridgeContract.address,
                    implBridgeV2Address],
            ),
            ethers.constants.HashZero,
            ethers.constants.HashZero,
        );

        // Schedule operation
        await timelockContract.schedule(
            operation.target,
            operation.value,
            operation.data,
            operation.predecessor,
            operation.salt,
            minDelay,
        );

        // Can't upgrade because the timeout didint expire yet
        await expect(timelockContract.execute(
            operation.target,
            operation.value,
            operation.data,
            operation.predecessor,
            operation.salt,
        )).to.be.revertedWith('TimelockController: operation is not ready');

        // Check that is the v0 contract
        await expect(supernets2BridgeContractV2.maxEtherBridge()).to.be.reverted;

        await ethers.provider.send('evm_increaseTime', [minDelay]);
        await timelockContract.execute(
            operation.target,
            operation.value,
            operation.data,
            operation.predecessor,
            operation.salt,
        );

        await expect(await supernets2BridgeContractV2.maxEtherBridge()).to.be.equal(0);
    });

    it('Should check thet in emergency state the minDelay is 0', async () => {
        // Upgrade the contract
        const supernets2BridgeFactoryV2 = await ethers.getContractFactory('Supernets2BridgeMock');
        const supernets2BridgeContractV2 = supernets2BridgeFactoryV2.attach(supernets2BridgeContract.address);

        // Check that is the v0 contract
        await expect(supernets2BridgeContractV2.maxEtherBridge()).to.be.reverted;

        // Transfer ownership to timelock

        // Can't upgrade the contract since it does not have the ownership
        await expect(upgrades.upgradeProxy(supernets2BridgeContract.address, supernets2BridgeFactoryV2))
            .to.be.reverted;

        const implBridgeV2Address = await upgrades.prepareUpgrade(supernets2BridgeContract.address, supernets2BridgeFactoryV2);
        const proxyAdmin = await upgrades.admin.getInstance();

        // Use timelock
        const operation = genOperation(
            proxyAdmin.address,
            0,
            proxyAdmin.interface.encodeFunctionData(
                'upgrade',
                [supernets2BridgeContract.address,
                    implBridgeV2Address],
            ),
            ethers.constants.HashZero,
            ethers.constants.HashZero,
        );

        // Check current delay
        expect(await timelockContract.getMinDelay()).to.be.equal(minDelay);

        // Put supernets2 contract on emergency mode
        await supernets2Contract.activateEmergencyState(0);

        // Check delay is 0
        expect(await timelockContract.getMinDelay()).to.be.equal(0);

        // Schedule operation
        await timelockContract.schedule(
            operation.target,
            operation.value,
            operation.data,
            operation.predecessor,
            operation.salt,
            0,
        );

        // Check that is the v0 contract
        await expect(supernets2BridgeContractV2.maxEtherBridge()).to.be.reverted;

        // Transaction cna be executed, delay is reduced to 0, but fails bc this timelock is not owner
        await expect(timelockContract.execute(
            operation.target,
            operation.value,
            operation.data,
            operation.predecessor,
            operation.salt,
        )).to.be.revertedWith('TimelockController: underlying transaction reverted');
    });

    it('Should reprocude L2 enviromanet and check upgradability', async () => {
        const timelockContractFactory = await ethers.getContractFactory('Supernets2Timelock');
        const proposers = [deployer.address];
        const executors = [deployer.address];
        const adminAddress = deployer.address;
        const timelockContractL2 = await timelockContractFactory.deploy(
            minDelay,
            proposers,
            executors,
            adminAddress,
            ethers.constants.AddressZero,
        );
        await timelockContractL2.deployed();

        // Check deploy parameters
        expect(await timelockContractL2.getMinDelay()).to.be.equal(minDelay);
        expect(await timelockContractL2.supernets2()).to.be.equal(ethers.constants.AddressZero);

        // Upgrade the contract
        const supernets2BridgeFactoryV2 = await ethers.getContractFactory('Supernets2BridgeMock');
        const supernets2BridgeContractV2 = supernets2BridgeFactoryV2.attach(supernets2BridgeContract.address);

        // Check that is the v0 contract
        await expect(supernets2BridgeContractV2.maxEtherBridge()).to.be.reverted;

        // Transfer ownership to timelock

        // Can't upgrade the contract since it does not have the ownership
        await expect(upgrades.upgradeProxy(supernets2BridgeContract.address, supernets2BridgeFactoryV2))
            .to.be.reverted;

        const implBridgeV2Address = await upgrades.prepareUpgrade(supernets2BridgeContract.address, supernets2BridgeFactoryV2);
        const proxyAdmin = await upgrades.admin.getInstance();

        // Use timelock
        const operation = genOperation(
            proxyAdmin.address,
            0,
            proxyAdmin.interface.encodeFunctionData(
                'upgrade',
                [supernets2BridgeContract.address,
                    implBridgeV2Address],
            ),
            ethers.constants.HashZero,
            ethers.constants.HashZero,
        );

        // Check current delay
        expect(await timelockContractL2.getMinDelay()).to.be.equal(minDelay);

        /*
         * Put supernets2 contract on emergency mode
         * Does not affect thsi deployment
         */
        await supernets2Contract.activateEmergencyState(0);

        // Check delay is 0
        expect(await timelockContractL2.getMinDelay()).to.be.equal(minDelay);

        // Schedule operation
        await expect(timelockContractL2.schedule(
            operation.target,
            operation.value,
            operation.data,
            operation.predecessor,
            operation.salt,
            0,
        )).to.be.revertedWith('TimelockController: insufficient delay');

        await timelockContractL2.schedule(
            operation.target,
            operation.value,
            operation.data,
            operation.predecessor,
            operation.salt,
            minDelay,
        );

        // Check that is the v0 contract
        await expect(supernets2BridgeContractV2.maxEtherBridge()).to.be.reverted;

        // Transaction cna be executed, delay is reduced to 0, but fails bc this timelock is not owner
        await expect(timelockContractL2.execute(
            operation.target,
            operation.value,
            operation.data,
            operation.predecessor,
            operation.salt,
        )).to.be.revertedWith('TimelockController: operation is not ready');
    });
});
