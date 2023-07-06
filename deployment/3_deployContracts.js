/* eslint-disable no-await-in-loop, no-use-before-define, no-lonely-if, import/no-dynamic-require, global-require */
/* eslint-disable no-console, no-inner-declarations, no-undef, import/no-unresolved, no-restricted-syntax */
const { expect } = require('chai');
const { ethers, upgrades } = require('hardhat');
const path = require('path');
const fs = require('fs');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

const { create2Deployment } = require('./helpers/deployment-helpers');

const pathOutputJson = path.join(__dirname, './deploy_output.json');
const pathOngoingDeploymentJson = path.join(__dirname, './deploy_ongoing.json');

const deployParameters = require('./deploy_parameters.json');
const genesis = require('./genesis.json');

const pathOZUpgradability = path.join(__dirname, `../.openzeppelin/${process.env.HARDHAT_NETWORK}.json`);

async function main() {
    // Check that there's no previous OZ deployment
    if (fs.existsSync(pathOZUpgradability)) {
        throw new Error(`There's upgradability information from previous deployments, it's mandatory to erase them before start a new one, path: ${pathOZUpgradability}`);
    }

    // Check if there's an ongoing deployment
    let ongoingDeployment = {};
    if (fs.existsSync(pathOngoingDeploymentJson)) {
        ongoingDeployment = require(pathOngoingDeploymentJson);
    }

    // Constant variables
    const networkIDMainnet = 0;
    const attemptsDeployProxy = 20;

    /*
     * Check deploy parameters
     * Check that every necessary parameter is fullfilled
     */
    const mandatoryDeploymentParameters = [
        'realVerifier',
        'trustedSequencerURL',
        'networkName',
        'version',
        'trustedSequencer',
        'chainID',
        'admin',
        'trustedAggregator',
        'trustedAggregatorTimeout',
        'pendingStateTimeout',
        'forkID',
        'supernets2dot0Owner',
        'timelockAddress',
        'minDelayTimelock',
        'salt',
        'supernets2dot0DeployerAddress',
        'maticTokenAddress',
        'setupEmptyCommittee',
        'committeeTimelock',
    ];

    for (const parameterName of mandatoryDeploymentParameters) {
        if (deployParameters[parameterName] === undefined || deployParameters[parameterName] === '') {
            throw new Error(`Missing parameter: ${parameterName}`);
        }
    }

    const {
        realVerifier,
        trustedSequencerURL,
        networkName,
        version,
        trustedSequencer,
        chainID,
        admin,
        trustedAggregator,
        trustedAggregatorTimeout,
        pendingStateTimeout,
        forkID,
        supernets2dot0Owner,
        timelockAddress,
        minDelayTimelock,
        salt,
        supernets2dot0DeployerAddress,
        maticTokenAddress,
        setupEmptyCommittee,
        committeeTimelock,
    } = deployParameters;

    // Load provider
    let currentProvider = ethers.provider;
    if (deployParameters.multiplierGas || deployParameters.maxFeePerGas) {
        if (process.env.HARDHAT_NETWORK !== 'hardhat') {
            currentProvider = new ethers.providers.JsonRpcProvider(`https://${process.env.HARDHAT_NETWORK}.infura.io/v3/${process.env.INFURA_PROJECT_ID}`);
            if (deployParameters.maxPriorityFeePerGas && deployParameters.maxFeePerGas) {
                console.log(`Hardcoded gas used: MaxPriority${deployParameters.maxPriorityFeePerGas} gwei, MaxFee${deployParameters.maxFeePerGas} gwei`);
                const FEE_DATA = {
                    maxFeePerGas: ethers.utils.parseUnits(deployParameters.maxFeePerGas, 'gwei'),
                    maxPriorityFeePerGas: ethers.utils.parseUnits(deployParameters.maxPriorityFeePerGas, 'gwei'),
                };
                currentProvider.getFeeData = async () => FEE_DATA;
            } else {
                console.log('Multiplier gas used: ', deployParameters.multiplierGas);
                async function overrideFeeData() {
                    const feedata = await ethers.provider.getFeeData();
                    return {
                        maxFeePerGas: feedata.maxFeePerGas.mul(deployParameters.multiplierGas).div(1000),
                        maxPriorityFeePerGas: feedata.maxPriorityFeePerGas.mul(deployParameters.multiplierGas).div(1000),
                    };
                }
                currentProvider.getFeeData = overrideFeeData;
            }
        }
    }

    // Load deployer
    let deployer;
    if (deployParameters.deployerPvtKey) {
        deployer = new ethers.Wallet(deployParameters.deployerPvtKey, currentProvider);
        console.log('Using pvtKey deployer with address: ', deployer.address);
    } else if (process.env.MNEMONIC) {
        deployer = ethers.Wallet.fromMnemonic(process.env.MNEMONIC, 'm/44\'/60\'/0\'/0/0').connect(currentProvider);
        console.log('Using MNEMONIC deployer with address: ', deployer.address);
    } else {
        [deployer] = (await ethers.getSigners());
    }

    // Load supernets2dot0 deployer
    const Supernets2dot0DeployerFactory = await ethers.getContractFactory('Supernets2dot0Deployer', deployer);
    const supernets2dot0DeployerContract = Supernets2dot0DeployerFactory.attach(supernets2dot0DeployerAddress);

    // check deployer is the owner of the deployer
    if (await deployer.provider.getCode(supernets2dot0DeployerContract.address) === '0x') {
        throw new Error('supernets2dot0 deployer contract is not deployed');
    }
    expect(deployer.address).to.be.equal(await supernets2dot0DeployerContract.owner());

    let verifierContract;
    if (!ongoingDeployment.verifierContract) {
        if (realVerifier === true) {
            const VerifierRollup = await ethers.getContractFactory('FflonkVerifier', deployer);
            verifierContract = await VerifierRollup.deploy();
            await verifierContract.deployed();
        } else {
            const VerifierRollupHelperFactory = await ethers.getContractFactory('VerifierRollupHelperMock', deployer);
            verifierContract = await VerifierRollupHelperFactory.deploy();
            await verifierContract.deployed();
        }
        console.log('#######################\n');
        console.log('Verifier deployed to:', verifierContract.address);

        // save an ongoing deployment
        ongoingDeployment.verifierContract = verifierContract.address;
        fs.writeFileSync(pathOngoingDeploymentJson, JSON.stringify(ongoingDeployment, null, 1));
    } else {
        console.log('Verifier already deployed on: ', ongoingDeployment.verifierContract);
        const VerifierRollupFactory = await ethers.getContractFactory('FflonkVerifier', deployer);
        verifierContract = VerifierRollupFactory.attach(ongoingDeployment.verifierContract);
    }

    /*
     * Deploy Bridge
     * Deploy admin --> implementation --> proxy
     */

    // Deploy proxy admin:
    const proxyAdminFactory = await ethers.getContractFactory('ProxyAdmin', deployer);
    const deployTransactionAdmin = (proxyAdminFactory.getDeployTransaction()).data;
    const dataCallAdmin = proxyAdminFactory.interface.encodeFunctionData('transferOwnership', [deployer.address]);
    const [proxyAdminAddress, isProxyAdminDeployed] = await create2Deployment(
        supernets2dot0DeployerContract,
        salt,
        deployTransactionAdmin,
        dataCallAdmin,
        deployer,
    );

    if (isProxyAdminDeployed) {
        console.log('#######################\n');
        console.log('Proxy admin deployed to:', proxyAdminAddress);
    } else {
        console.log('#######################\n');
        console.log('Proxy admin was already deployed to:', proxyAdminAddress);
    }

    // Deploy implementation Supernets2dot0Bridge
    const supernets2dot0BridgeFactory = await ethers.getContractFactory('Supernets2dot0Bridge', deployer);
    const deployTransactionBridge = (supernets2dot0BridgeFactory.getDeployTransaction()).data;
    const dataCallNull = null;
    // Mandatory to override the gasLimit since the estimation with create are mess up D:
    const overrideGasLimit = ethers.BigNumber.from(5500000);
    const [bridgeImplementationAddress, isBridgeImplDeployed] = await create2Deployment(
        supernets2dot0DeployerContract,
        salt,
        deployTransactionBridge,
        dataCallNull,
        deployer,
        overrideGasLimit,
    );

    if (isBridgeImplDeployed) {
        console.log('#######################\n');
        console.log('bridge impl deployed to:', bridgeImplementationAddress);
    } else {
        console.log('#######################\n');
        console.log('bridge impl was already deployed to:', bridgeImplementationAddress);
    }

    /*
     * deploy proxy
     * Do not initialize directly the proxy since we want to deploy the same code on L2 and this will alter the bytecode deployed of the proxy
     */
    const transparentProxyFactory = await ethers.getContractFactory('TransparentUpgradeableProxy', deployer);
    const initializeEmptyDataProxy = '0x';
    const deployTransactionProxy = (transparentProxyFactory.getDeployTransaction(
        bridgeImplementationAddress,
        proxyAdminAddress,
        initializeEmptyDataProxy,
    )).data;

    /*
     * Nonce globalExitRoot: currentNonce + 1 (deploy bridge proxy) + 1(impl globalExitRoot
     * + 1 (deploy data comittee proxy) + 1(impl data committee) + setupCommitte? = +4 or +5
     */
    const nonceDelta = 4 + (setupEmptyCommittee ? 1 : 0);
    const nonceProxyGlobalExitRoot = Number((await ethers.provider.getTransactionCount(deployer.address)))
        + nonceDelta;
    // nonceProxySupernets2dot0 :Nonce globalExitRoot + 1 (proxy globalExitRoot) + 1 (impl supernets) = +2
    const nonceProxySupernets2dot0 = nonceProxyGlobalExitRoot + 2;

    let precalculateGLobalExitRootAddress; let
        precalculateSupernets2dot0Address;

    // Check if the contract is already deployed
    if (ongoingDeployment.supernets2dot0GlobalExitRoot && ongoingDeployment.supernets2dot0Contract) {
        precalculateGLobalExitRootAddress = ongoingDeployment.supernets2dot0GlobalExitRoot;
        precalculateSupernets2dot0Address = ongoingDeployment.supernets2dot0Contract;
    } else {
        // If both are not deployed, it's better to deploy them both again
        delete ongoingDeployment.supernets2dot0GlobalExitRoot;
        delete ongoingDeployment.supernets2dot0Contract;
        fs.writeFileSync(pathOngoingDeploymentJson, JSON.stringify(ongoingDeployment, null, 1));

        // Contracts are not deployed, normal deployment
        precalculateGLobalExitRootAddress = ethers.utils.getContractAddress({ from: deployer.address, nonce: nonceProxyGlobalExitRoot });
        precalculateSupernets2dot0Address = ethers.utils.getContractAddress({ from: deployer.address, nonce: nonceProxySupernets2dot0 });
    }

    const dataCallProxy = supernets2dot0BridgeFactory.interface.encodeFunctionData(
        'initialize',
        [
            networkIDMainnet,
            precalculateGLobalExitRootAddress,
            precalculateSupernets2dot0Address,
        ],
    );
    const [proxyBridgeAddress, isBridgeProxyDeployed] = await create2Deployment(
        supernets2dot0DeployerContract,
        salt,
        deployTransactionProxy,
        dataCallProxy,
        deployer,
    );
    const supernets2dot0BridgeContract = supernets2dot0BridgeFactory.attach(proxyBridgeAddress);

    if (isBridgeProxyDeployed) {
        console.log('#######################\n');
        console.log('Supernets2dot0Bridge deployed to:', supernets2dot0BridgeContract.address);
    } else {
        console.log('#######################\n');
        console.log('Supernets2dot0Bridge was already deployed to:', supernets2dot0BridgeContract.address);

        // If it was already deployed, check that the initialized calldata matches the actual deployment
        expect(precalculateGLobalExitRootAddress).to.be.equal(await supernets2dot0BridgeContract.globalExitRootManager());
        expect(precalculateSupernets2dot0Address).to.be.equal(await supernets2dot0BridgeContract.supernets2dot0address());
    }

    console.log('\n#######################');
    console.log('#####    Checks Supernets2dot0Bridge   #####');
    console.log('#######################');
    console.log('Supernets2dot0GlobalExitRootAddress:', await supernets2dot0BridgeContract.globalExitRootManager());
    console.log('networkID:', await supernets2dot0BridgeContract.networkID());
    console.log('supernets2dot0address:', await supernets2dot0BridgeContract.supernets2dot0address());

    // Import OZ manifest the deployed contracts, its enough to import just the proxy, the rest are imported automatically (admin/impl)
    await upgrades.forceImport(proxyBridgeAddress, supernets2dot0BridgeFactory, 'transparent');

    /*
     * Deployment Data Committee
     */
    let supernets2dot0DataCommitteeContract;
    const Supernets2dot0DataCommitteeContractFactory = await ethers.getContractFactory('Supernets2dot0DataCommittee', deployer);
    for (let i = 0; i < attemptsDeployProxy; i++) {
        try {
            supernets2dot0DataCommitteeContract = await upgrades.deployProxy(
                Supernets2dot0DataCommitteeContractFactory,
                [],
            );
            break;
        } catch (error) {
            console.log(`attempt ${i}`);
            console.log('upgrades.deployProxy of supernets2dot0DataCommitteeContract ', error.message);
        }

        // reach limits of attempts
        if (i + 1 === attemptsDeployProxy) {
            throw new Error('supernets2dot0DataCommitteeContract contract has not been deployed');
        }
    }

    console.log('#######################\n');
    console.log('supernets2dot0DataCommittee deployed to:', supernets2dot0DataCommitteeContract.address);

    if (setupEmptyCommittee) {
        const expectedHash = ethers.utils.solidityKeccak256(['bytes'], [[]]);
        await expect(supernets2dot0DataCommitteeContract.connect(deployer)
            .setupCommittee(0, [], []))
            .to.emit(supernets2dot0DataCommitteeContract, 'CommitteeUpdated')
            .withArgs(expectedHash);
        console.log('Empty committee seted up');
    }

    /*
     *Deployment Global exit root manager
     */
    let supernets2dot0GlobalExitRoot;
    const Supernets2dot0GlobalExitRootFactory = await ethers.getContractFactory('Supernets2dot0GlobalExitRoot', deployer);
    if (!ongoingDeployment.supernets2dot0GlobalExitRoot) {
        for (let i = 0; i < attemptsDeployProxy; i++) {
            try {
                supernets2dot0GlobalExitRoot = await upgrades.deployProxy(Supernets2dot0GlobalExitRootFactory, [], {
                    initializer: false,
                    constructorArgs: [precalculateSupernets2dot0Address, proxyBridgeAddress],
                    unsafeAllow: ['constructor', 'state-variable-immutable'],
                });
                break;
            } catch (error) {
                console.log(`attempt ${i}`);
                console.log('upgrades.deployProxy of supernets2dot0GlobalExitRoot ', error.message);
            }

            // reach limits of attempts
            if (i + 1 === attemptsDeployProxy) {
                throw new Error('supernets2dot0GlobalExitRoot contract has not been deployed');
            }
        }

        expect(precalculateGLobalExitRootAddress).to.be.equal(supernets2dot0GlobalExitRoot.address);

        console.log('#######################\n');
        console.log('supernets2dot0GlobalExitRoot deployed to:', supernets2dot0GlobalExitRoot.address);

        // save an ongoing deployment
        ongoingDeployment.supernets2dot0GlobalExitRoot = supernets2dot0GlobalExitRoot.address;
        fs.writeFileSync(pathOngoingDeploymentJson, JSON.stringify(ongoingDeployment, null, 1));
    } else {
        // sanity check
        expect(precalculateGLobalExitRootAddress).to.be.equal(supernets2dot0GlobalExitRoot.address);
        // Expect the precalculate address matches de onogin deployment
        supernets2dot0GlobalExitRoot = Supernets2dot0GlobalExitRootFactory.attach(ongoingDeployment.supernets2dot0GlobalExitRoot);

        console.log('#######################\n');
        console.log('supernets2dot0GlobalExitRoot already deployed on: ', ongoingDeployment.supernets2dot0GlobalExitRoot);

        // Import OZ manifest the deployed contracts, its enough to import just the proyx, the rest are imported automatically (admin/impl)
        await upgrades.forceImport(ongoingDeployment.supernets2dot0GlobalExitRoot, Supernets2dot0GlobalExitRootFactory, 'transparent');

        // Check against current deployment
        expect(supernets2dot0BridgeContract.address).to.be.equal(await supernets2dot0BridgeContract.bridgeAddress());
        expect(precalculateSupernets2dot0Address).to.be.equal(await supernets2dot0BridgeContract.rollupAddress());
    }

    // deploy Supernets2dot0M
    const genesisRootHex = genesis.root;

    console.log('\n#######################');
    console.log('##### Deployment Polygon ZK-EVM #####');
    console.log('#######################');
    console.log('deployer:', deployer.address);
    console.log('Supernets2dot0GlobalExitRootAddress:', supernets2dot0GlobalExitRoot.address);
    console.log('maticTokenAddress:', maticTokenAddress);
    console.log('verifierAddress:', verifierContract.address);
    console.log('supernets2dot0BridgeContract:', supernets2dot0BridgeContract.address);

    console.log('admin:', admin);
    console.log('chainID:', chainID);
    console.log('trustedSequencer:', trustedSequencer);
    console.log('pendingStateTimeout:', pendingStateTimeout);
    console.log('trustedAggregator:', trustedAggregator);
    console.log('trustedAggregatorTimeout:', trustedAggregatorTimeout);

    console.log('genesisRoot:', genesisRootHex);
    console.log('trustedSequencerURL:', trustedSequencerURL);
    console.log('networkName:', networkName);
    console.log('forkID:', forkID);

    const Supernets2dot0Factory = await ethers.getContractFactory('Supernets2dot0', deployer);

    let supernets2dot0Contract;
    let deploymentBlockNumber;
    if (!ongoingDeployment.supernets2dot0Contract) {
        for (let i = 0; i < attemptsDeployProxy; i++) {
            try {
                supernets2dot0Contract = await upgrades.deployProxy(
                    Supernets2dot0Factory,
                    [
                        {
                            admin,
                            trustedSequencer,
                            pendingStateTimeout,
                            trustedAggregator,
                            trustedAggregatorTimeout,
                        },
                        genesisRootHex,
                        trustedSequencerURL,
                        networkName,
                        version,
                    ],
                    {
                        constructorArgs: [
                            supernets2dot0GlobalExitRoot.address,
                            maticTokenAddress,
                            verifierContract.address,
                            supernets2dot0BridgeContract.address,
                            supernets2dot0DataCommitteeContract.address,
                            chainID,
                            forkID,
                        ],
                        unsafeAllow: ['constructor', 'state-variable-immutable'],
                    },
                );
                break;
            } catch (error) {
                console.log(`attempt ${i}`);
                console.log('upgrades.deployProxy of supernets2dot0Contract ', error.message);
            }

            // reach limits of attempts
            if (i + 1 === attemptsDeployProxy) {
                throw new Error('Supernets2dot0 contract has not been deployed');
            }
        }

        expect(precalculateSupernets2dot0Address).to.be.equal(supernets2dot0Contract.address);

        console.log('#######################\n');
        console.log('supernets2dot0Contract deployed to:', supernets2dot0Contract.address);

        // save an ongoing deployment
        ongoingDeployment.supernets2dot0Contract = supernets2dot0Contract.address;
        fs.writeFileSync(pathOngoingDeploymentJson, JSON.stringify(ongoingDeployment, null, 1));

        // Transfer ownership of supernets2dot0Contract
        if (supernets2dot0Owner !== deployer.address) {
            await (await supernets2dot0Contract.transferOwnership(supernets2dot0Owner)).wait();
        }

        deploymentBlockNumber = (await supernets2dot0Contract.deployTransaction.wait()).blockNumber;
    } else {
        // Expect the precalculate address matches de onogin deployment, sanity check
        expect(precalculateSupernets2dot0Address).to.be.equal(ongoingDeployment.supernets2dot0Contract);
        supernets2dot0Contract = Supernets2dot0Factory.attach(ongoingDeployment.supernets2dot0Contract);

        console.log('#######################\n');
        console.log('supernets2dot0Contract already deployed on: ', ongoingDeployment.supernets2dot0Contract);

        // Import OZ manifest the deployed contracts, its enough to import just the proyx, the rest are imported automatically ( admin/impl)
        await upgrades.forceImport(ongoingDeployment.supernets2dot0Contract, Supernets2dot0Factory, 'transparent');

        const supernets2dot0OwnerContract = await supernets2dot0Contract.owner();
        if (supernets2dot0OwnerContract === deployer.address) {
            // Transfer ownership of supernets2dot0Contract
            if (supernets2dot0Owner !== deployer.address) {
                await (await supernets2dot0Contract.transferOwnership(supernets2dot0Owner)).wait();
            }
        } else {
            expect(supernets2dot0Owner).to.be.equal(supernets2dot0OwnerContract);
        }
        deploymentBlockNumber = 0;
    }

    console.log('\n#######################');
    console.log('#####    Checks  Supernets2dot0  #####');
    console.log('#######################');
    console.log('Supernets2dot0GlobalExitRootAddress:', await supernets2dot0Contract.globalExitRootManager());
    console.log('maticTokenAddress:', await supernets2dot0Contract.matic());
    console.log('verifierAddress:', await supernets2dot0Contract.rollupVerifier());
    console.log('supernets2dot0BridgeContract:', await supernets2dot0Contract.bridgeAddress());

    console.log('admin:', await supernets2dot0Contract.admin());
    console.log('chainID:', await supernets2dot0Contract.chainID());
    console.log('trustedSequencer:', await supernets2dot0Contract.trustedSequencer());
    console.log('pendingStateTimeout:', await supernets2dot0Contract.pendingStateTimeout());
    console.log('trustedAggregator:', await supernets2dot0Contract.trustedAggregator());
    console.log('trustedAggregatorTimeout:', await supernets2dot0Contract.trustedAggregatorTimeout());

    console.log('genesiRoot:', await supernets2dot0Contract.batchNumToStateRoot(0));
    console.log('trustedSequencerURL:', await supernets2dot0Contract.trustedSequencerURL());
    console.log('networkName:', await supernets2dot0Contract.networkName());
    console.log('owner:', await supernets2dot0Contract.owner());
    console.log('forkID:', await supernets2dot0Contract.forkID());

    // Assert admin address
    expect(await upgrades.erc1967.getAdminAddress(precalculateSupernets2dot0Address)).to.be.equal(proxyAdminAddress);
    expect(await upgrades.erc1967.getAdminAddress(precalculateGLobalExitRootAddress)).to.be.equal(proxyAdminAddress);
    expect(await upgrades.erc1967.getAdminAddress(proxyBridgeAddress)).to.be.equal(proxyAdminAddress);

    const proxyAdminInstance = proxyAdminFactory.attach(proxyAdminAddress);
    const proxyAdminOwner = await proxyAdminInstance.owner();
    const timelockContractFactory = await ethers.getContractFactory('Supernets2dot0Timelock', deployer);

    // TODO test stop here

    let timelockContract;
    if (proxyAdminOwner !== deployer.address) {
        // Check if there's a timelock deployed there that match the current deployment
        timelockContract = timelockContractFactory.attach(proxyAdminOwner);
        expect(precalculateSupernets2dot0Address).to.be.equal(await timelockContract.supernets2dot0());

        console.log('#######################\n');
        console.log(
            'Polygon timelockContract already deployed to:',
            timelockContract.address,
        );
    } else {
        // deploy timelock
        console.log('\n#######################');
        console.log('##### Deployment TimelockContract  #####');
        console.log('#######################');
        console.log('minDelayTimelock:', minDelayTimelock);
        console.log('timelockAddress:', timelockAddress);
        console.log('supernets2dot0Address:', supernets2dot0Contract.address);
        timelockContract = await timelockContractFactory.deploy(
            minDelayTimelock,
            [timelockAddress],
            [timelockAddress],
            timelockAddress,
            supernets2dot0Contract.address,
        );
        await timelockContract.deployed();
        console.log('#######################\n');
        console.log(
            'Polygon timelockContract deployed to:',
            timelockContract.address,
        );

        // Transfer ownership of the proxyAdmin to timelock
        await upgrades.admin.transferProxyAdminOwnership(timelockContract.address);
    }

    if (committeeTimelock) {
        await (await supernets2dot0DataCommitteeContract.transferOwnership(timelockContract.address)).wait();
    }

    console.log('\n#######################');
    console.log('#####  Checks TimelockContract  #####');
    console.log('#######################');
    console.log('minDelayTimelock:', await timelockContract.getMinDelay());
    console.log('supernets2dot0:', await timelockContract.supernets2dot0());

    const outputJson = {
        supernets2dot0Address: supernets2dot0Contract.address,
        supernets2dot0BridgeAddress: supernets2dot0BridgeContract.address,
        supernets2dot0GlobalExitRootAddress: supernets2dot0GlobalExitRoot.address,
        supernets2dot0DataCommitteeContract: supernets2dot0DataCommitteeContract.address,
        maticTokenAddress,
        verifierAddress: verifierContract.address,
        supernets2dot0DeployerContract: supernets2dot0DeployerContract.address,
        deployerAddress: deployer.address,
        timelockContractAddress: timelockContract.address,
        deploymentBlockNumber,
        genesisRoot: genesisRootHex,
        trustedSequencer,
        trustedSequencerURL,
        chainID,
        networkName,
        admin,
        trustedAggregator,
        proxyAdminAddress,
        forkID,
        salt,
        version,
    };
    fs.writeFileSync(pathOutputJson, JSON.stringify(outputJson, null, 1));

    // Remove ongoing deployment
    fs.unlinkSync(pathOngoingDeploymentJson);
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
