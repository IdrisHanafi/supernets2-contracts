const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });
process.env.HARDHAT_NETWORK = "hardhat";
const { ethers } = require("hardhat");
const { expect } = require('chai');

const deployMainnet = require("./mainnetDeployment.json");
const mainnetDeployParameters = require("./mainnetDeployParameters.json");

const pathFflonkVerifier = '../artifacts/contracts/verifiers/FflonkVerifier.sol/FflonkVerifier.json';
const pathSupernets2dot0Deployer = '../artifacts/contracts/deployment/Supernets2dot0Deployer.sol/Supernets2dot0Deployer.json';
const pathSupernets2dot0Bridge = '../artifacts/contracts/Supernets2dot0Bridge.sol/Supernets2dot0Bridge.json';
const pathTransparentProxyOZUpgradeDep = '../node_modules/@openzeppelin/upgrades-core/artifacts/@openzeppelin/contracts/proxy/transparent/TransparentUpgradeableProxy.sol/TransparentUpgradeableProxy.json';
const pathProxyAdmin = '../artifacts/@openzeppelin/contracts/proxy/transparent/ProxyAdmin.sol/ProxyAdmin.json';
const pathTransparentProxy = '../artifacts/@openzeppelin/contracts/proxy/transparent/TransparentUpgradeableProxy.sol/TransparentUpgradeableProxy.json';
const pathSupernets2dot0Timelock = '../artifacts/contracts/Supernets2dot0Timelock.sol/Supernets2dot0Timelock.json';
const pathSupernets2dot0 = '../artifacts/contracts/Supernets2dot0.sol/Supernets2dot0.json';
const pathSupernets2dot0GlobalExitRoot = '../artifacts/contracts/Supernets2dot0GlobalExitRoot.sol/Supernets2dot0GlobalExitRoot.json';

const FflonkVerifier = require(pathFflonkVerifier);
const Supernets2dot0Deployer = require(pathSupernets2dot0Deployer);
const Supernets2dot0Bridge = require(pathSupernets2dot0Bridge);
const TransparentProxyOZUpgradeDep = require(pathTransparentProxyOZUpgradeDep);
const ProxyAdmin = require(pathProxyAdmin);
const TransparentProxy = require(pathTransparentProxy);


const etherscanURL = "https://etherscan.io/address/"
async function main() {
    // First verify not immutable conracts
    const mainnetProvider = new ethers.providers.JsonRpcProvider(`https://mainnet.infura.io/v3/${process.env.INFURA_PROJECT_ID}`);

    // FflonkVerifier
    expect(await mainnetProvider.getCode(deployMainnet.fflonkVerifierAddress))
        .to.be.equal(FflonkVerifier.deployedBytecode);
    console.log("FflonkVerifier was correctly verified")
    console.log("Etherscan URL: ", etherscanURL + deployMainnet.fflonkVerifierAddress)
    console.log("Path file: ", path.join(__dirname, pathFflonkVerifier));
    console.log();

    // Supernets2dot0Deployer
    expect(await mainnetProvider.getCode(deployMainnet.supernets2dot0DeployerAddress))
        .to.be.equal(Supernets2dot0Deployer.deployedBytecode);
    console.log("Supernets2dot0Deployer was correctly verified")
    console.log("Etherscan URL: ", etherscanURL + deployMainnet.supernets2dot0DeployerAddress)
    console.log("Path file: ", path.join(__dirname, pathSupernets2dot0Deployer));
    console.log();

    // Bridge
    // Since this contract is a proxy, we will need to verify the implementation
    const supernets2dot0BridgeImpl = await getImplementationAddress(deployMainnet.supernets2dot0BridgeAddress, mainnetProvider)

    expect(await mainnetProvider.getCode(supernets2dot0BridgeImpl))
        .to.be.equal(Supernets2dot0Bridge.deployedBytecode);
    console.log("Supernets2dot0BridgeAddress implementation was correctly verified")
    console.log("Etherscan URL: ", etherscanURL + supernets2dot0BridgeImpl)
    console.log("Path file: ", path.join(__dirname, pathSupernets2dot0Bridge));
    console.log();

    // Check transparent Proxys
    expect(await mainnetProvider.getCode(deployMainnet.supernets2dot0BridgeAddress))
        .to.be.equal(TransparentProxy.deployedBytecode);
    console.log("Supernets2dot0BridgeAddress proxy was correctly verified")
    console.log("Etherscan URL: ", etherscanURL + deployMainnet.supernets2dot0BridgeAddress);
    console.log("Path file: ", path.join(__dirname, pathTransparentProxy));
    console.log();

    // The other 3 contracts are immutables, therefore we will deploy them locally and check the btyecode against the deployed one

    // Supernets2dot0Timelock
    const Supernets2dot0TimelockFactory = await ethers.getContractFactory('Supernets2dot0Timelock');
    const timelockAddress = mainnetDeployParameters.timelockAddress; //not relevant to deployed bytecode
    const minDelayTimelock = mainnetDeployParameters.minDelayTimelock; //not relevant to deployed bytecode

    const Supernets2dot0Timelock = await Supernets2dot0TimelockFactory.deploy(
        minDelayTimelock,
        [timelockAddress],
        [timelockAddress],
        timelockAddress,
        deployMainnet.supernets2dot0Address,
    );
    Supernets2dot0Timelock.deployed()

    const deployedBytecodeSupernets2dot0Timelock = await ethers.provider.getCode(Supernets2dot0Timelock.address);
    expect(await mainnetProvider.getCode(deployMainnet.supernets2dot0TimelockAddress))
        .to.be.equal(deployedBytecodeSupernets2dot0Timelock);
    console.log("Timelock was correctly verified")
    console.log("Etherscan URL: ", etherscanURL + deployMainnet.supernets2dot0TimelockAddress);
    console.log("Path file: ", path.join(__dirname, pathSupernets2dot0Timelock));
    console.log();

    // supernets2dot0GlobalExitRoot
    const Supernets2dot0GlobalExitRootFactory = await ethers.getContractFactory('Supernets2dot0GlobalExitRoot');
    const supernets2dot0GlobalExitRoot = await Supernets2dot0GlobalExitRootFactory.deploy(
        deployMainnet.supernets2dot0Address,
        deployMainnet.supernets2dot0BridgeAddress
    );
    supernets2dot0GlobalExitRoot.deployed()

    const deployedBytecodeGlobalExitRoot = await ethers.provider.getCode(supernets2dot0GlobalExitRoot.address);
    const supernets2dot0GlobalImpl = await getImplementationAddress(deployMainnet.supernets2dot0GlobalExitRootAddress, mainnetProvider)

    expect(await mainnetProvider.getCode(supernets2dot0GlobalImpl))
        .to.be.equal(deployedBytecodeGlobalExitRoot);
    console.log("Supernets2dot0GlobalExitRoot implementation was correctly verified")
    console.log("Etherscan URL: ", etherscanURL + supernets2dot0GlobalImpl);
    console.log("Path file: ", path.join(__dirname, pathSupernets2dot0GlobalExitRoot));
    console.log();

    // Check transparent Proxys
    expect(await mainnetProvider.getCode(deployMainnet.supernets2dot0GlobalExitRootAddress))
        .to.be.equal(TransparentProxyOZUpgradeDep.deployedBytecode);
    console.log("Supernets2dot0GlobalExitRoot proxy was correctly verified")
    console.log("Etherscan URL: ", etherscanURL + deployMainnet.supernets2dot0GlobalExitRootAddress);
    console.log("Path file: ", path.join(__dirname, pathTransparentProxyOZUpgradeDep));
    console.log();

    // Supernets2dot0
    const mainnetChainID = mainnetDeployParameters.chainID;
    const mainnetForkID = mainnetDeployParameters.forkID;
    const maticAddress = mainnetDeployParameters.maticTokenAddress;

    const Supernets2dot0Factory = await ethers.getContractFactory('Supernets2dot0');
    const supernets2dot0Contract = await Supernets2dot0Factory.deploy(
        deployMainnet.supernets2dot0GlobalExitRootAddress,
        maticAddress,
        deployMainnet.fflonkVerifierAddress,
        deployMainnet.supernets2dot0BridgeAddress,
        mainnetChainID,
        mainnetForkID,
    );
    supernets2dot0Contract.deployed()

    const deployedBytecodeSupernets2dot0 = await ethers.provider.getCode(supernets2dot0Contract.address);
    const supernets2dot0Impl = await getImplementationAddress(deployMainnet.supernets2dot0Address, mainnetProvider)

    expect(await mainnetProvider.getCode(supernets2dot0Impl))
        .to.be.equal(deployedBytecodeSupernets2dot0);
    console.log("Supernets2dot0Address implementation was correctly verified")
    console.log("Etherscan URL: ", etherscanURL + supernets2dot0Impl);
    console.log("Path file: ", path.join(__dirname, pathSupernets2dot0));
    console.log();
    
    // Check transparent Proxys
    expect(await mainnetProvider.getCode(deployMainnet.supernets2dot0Address))
        .to.be.equal(TransparentProxyOZUpgradeDep.deployedBytecode);
    console.log("Supernets2dot0Address proxy was correctly verified")
    console.log("Etherscan URL: ", etherscanURL + deployMainnet.supernets2dot0Address);
    console.log("Path file: ", path.join(__dirname, pathTransparentProxyOZUpgradeDep));
    console.log();

    // Check proxy Admin
    const supernets2dot0BridgeAdmin = await getProxyAdminAddress(deployMainnet.supernets2dot0BridgeAddress, mainnetProvider);
    const supernets2dot0Admin = await getProxyAdminAddress(deployMainnet.supernets2dot0Address, mainnetProvider);
    const supernets2dot0GlobalExitRootAdmin = await getProxyAdminAddress(deployMainnet.supernets2dot0GlobalExitRootAddress, mainnetProvider);

    expect(supernets2dot0BridgeAdmin).to.be.equal(supernets2dot0Admin);
    expect(supernets2dot0Admin).to.be.equal(supernets2dot0GlobalExitRootAdmin);
    expect(await mainnetProvider.getCode(supernets2dot0Admin))
        .to.be.equal(ProxyAdmin.deployedBytecode);
    console.log("ProxyAdmin proxy was correctly verified")
    console.log("Etherscan URL: ", etherscanURL + supernets2dot0Admin);
    console.log("Path file: ", path.join(__dirname, pathProxyAdmin));
    console.log();

    // Assert genesis is the same as the provided in the document
    let mainnetPolygonZkVEM = (await ethers.getContractFactory('Supernets2dot0', mainnetProvider)).attach(deployMainnet.supernets2dot0Address);
    mainnetPolygonZkVEM = mainnetPolygonZkVEM.connect(mainnetProvider);
    expect(await mainnetPolygonZkVEM.batchNumToStateRoot(0)).to.be.equal(deployMainnet.genesisRoot);
    console.log("Genesis root was correctly verified:",deployMainnet.genesisRoot)

}
// We recommend this pattern to be able to use async/await everywhere
// and properly handle errors.
main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error(error);
        process.exit(1);
    });

//     bytes32 internal constant _ADMIN_SLOT = 0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103;
//     bytes32 internal constant _IMPLEMENTATION_SLOT = 0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc;
const adminSlot = "0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103";
const implSlot = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";

async function getImplementationAddress(proxyAddress, provider) {
    const implementationAddress = await provider.getStorageAt(proxyAddress, implSlot);
    return `0x${implementationAddress.slice(2 + (32 * 2 - 40))}`
}

async function getProxyAdminAddress(proxyAddress, provider) {
    const adminAddress = await provider.getStorageAt(proxyAddress, adminSlot);
    return `0x${adminAddress.slice(2 + (32 * 2 - 40))}`
}
