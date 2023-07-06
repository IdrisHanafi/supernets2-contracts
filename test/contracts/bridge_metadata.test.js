const { expect } = require('chai');
const { ethers, upgrades } = require('hardhat');
const MerkleTreeBridge = require('@0xpolygonhermez/zkevm-commonjs').MTBridge;
const {
    getLeafValue,
} = require('@0xpolygonhermez/zkevm-commonjs').mtBridgeUtils;

describe('Supernets2dot0Bridge Contract werid metadata', () => {
    let deployer;
    let rollup;

    let supernets2dot0GlobalExitRoot;
    let supernets2dot0BridgeContract;
    let tokenContract;

    const tokenName = 'Matic Token';
    const tokenSymbol = 'MATIC';
    const decimals = 18;
    const tokenInitialBalance = ethers.utils.parseEther('20000000');

    const networkIDMainnet = 0;
    const networkIDRollup = 1;
    const LEAF_TYPE_ASSET = 0;

    const supernets2dot0Address = ethers.constants.AddressZero;

    beforeEach('Deploy contracts', async () => {
        // load signers
        [deployer, rollup] = await ethers.getSigners();

        // deploy Supernets2dot0Bridge
        const supernets2dot0BridgeFactory = await ethers.getContractFactory('Supernets2dot0Bridge');
        supernets2dot0BridgeContract = await upgrades.deployProxy(supernets2dot0BridgeFactory, [], { initializer: false });

        // deploy global exit root manager
        const supernets2dot0GlobalExitRootFactory = await ethers.getContractFactory('Supernets2dot0GlobalExitRoot');
        supernets2dot0GlobalExitRoot = await supernets2dot0GlobalExitRootFactory.deploy(rollup.address, supernets2dot0BridgeContract.address);

        await supernets2dot0BridgeContract.initialize(networkIDMainnet, supernets2dot0GlobalExitRoot.address, supernets2dot0Address);

        // deploy token
        const maticTokenFactory = await ethers.getContractFactory('TokenWrapped');
        tokenContract = await maticTokenFactory.deploy(
            tokenName,
            tokenSymbol,
            decimals,
        );
        await tokenContract.deployed();

        await tokenContract.mint(deployer.address, tokenInitialBalance);
    });

    it('should Supernets2dot0Bridge with weird token metadata', async () => {
        const weirdErc20Metadata = await ethers.getContractFactory('ERC20WeirdMetadata');

        const nameWeird = 'nameToken';
        const symbolWeird = 'NTK';

        const nameWeirdBytes32 = ethers.utils.formatBytes32String(nameWeird);
        const symbolWeirdBytes = ethers.utils.toUtf8Bytes(symbolWeird);
        const decimalsWeird = 14;

        const weirdTokenContract = await weirdErc20Metadata.deploy(
            nameWeirdBytes32, // bytes32
            symbolWeirdBytes, // bytes
            decimalsWeird,
        );
        await weirdTokenContract.deployed();

        // mint and approve tokens
        await weirdTokenContract.mint(deployer.address, tokenInitialBalance);
        await weirdTokenContract.approve(supernets2dot0BridgeContract.address, tokenInitialBalance);

        const depositCount = await supernets2dot0BridgeContract.depositCount();
        const originNetwork = networkIDMainnet;
        const tokenAddress = weirdTokenContract.address;
        const amount = ethers.utils.parseEther('10');
        const destinationNetwork = networkIDRollup;
        const destinationAddress = deployer.address;

        const metadata = ethers.utils.defaultAbiCoder.encode(
            ['string', 'string', 'uint8'],
            [nameWeird, symbolWeird, decimalsWeird],
        );

        const metadataHash = ethers.utils.solidityKeccak256(['bytes'], [metadata]);

        // pre compute root merkle tree in Js
        const height = 32;
        const merkleTree = new MerkleTreeBridge(height);
        const leafValue = getLeafValue(
            LEAF_TYPE_ASSET,
            originNetwork,
            tokenAddress,
            destinationNetwork,
            destinationAddress,
            amount,
            metadataHash,
        );
        merkleTree.add(leafValue);
        const rootJSMainnet = merkleTree.getRoot();

        await expect(supernets2dot0BridgeContract.bridgeAsset(destinationNetwork, destinationAddress, amount, tokenAddress, true, '0x'))
            .to.emit(supernets2dot0BridgeContract, 'BridgeEvent')
            .withArgs(LEAF_TYPE_ASSET, originNetwork, tokenAddress, destinationNetwork, destinationAddress, amount, metadata, depositCount);

        expect(await supernets2dot0BridgeContract.getDepositRoot()).to.be.equal(rootJSMainnet);
    });

    it('should Supernets2dot0Bridge with weird token metadata with reverts', async () => {
        const weirdErc20Metadata = await ethers.getContractFactory('ERC20WeirdMetadata');

        const nameWeird = 'nameToken';
        const symbolWeird = 'NTK';

        const nameWeirdBytes32 = ethers.utils.formatBytes32String(nameWeird);
        const symbolWeirdBytes = ethers.utils.toUtf8Bytes(symbolWeird);
        const decimalsWeird = ethers.constants.MaxUint256;

        const weirdTokenContract = await weirdErc20Metadata.deploy(
            nameWeirdBytes32, // bytes32
            symbolWeirdBytes, // bytes
            decimalsWeird,
        );
        await weirdTokenContract.deployed();

        // mint and approve tokens
        await weirdTokenContract.mint(deployer.address, tokenInitialBalance);
        await weirdTokenContract.approve(supernets2dot0BridgeContract.address, tokenInitialBalance);

        const depositCount = await supernets2dot0BridgeContract.depositCount();
        const originNetwork = networkIDMainnet;
        const tokenAddress = weirdTokenContract.address;
        const amount = ethers.utils.parseEther('10');
        const destinationNetwork = networkIDRollup;
        const destinationAddress = deployer.address;

        // Since cannot decode decimals
        await expect(supernets2dot0BridgeContract.bridgeAsset(destinationNetwork, destinationAddress, amount, tokenAddress, true, '0x')).to.be.reverted;

        // toogle revert
        await weirdTokenContract.toggleIsRevert();
        // Use revert strings
        const nameRevert = 'NO_NAME';
        const symbolRevert = 'NO_SYMBOL';
        const decimalsTooRevert = 18;
        const metadata = ethers.utils.defaultAbiCoder.encode(
            ['string', 'string', 'uint8'],
            [nameRevert, symbolRevert, decimalsTooRevert],
        );

        const metadataHash = ethers.utils.solidityKeccak256(['bytes'], [metadata]);

        // pre compute root merkle tree in Js
        const height = 32;
        const merkleTree = new MerkleTreeBridge(height);
        const leafValue = getLeafValue(
            LEAF_TYPE_ASSET,
            originNetwork,
            tokenAddress,
            destinationNetwork,
            destinationAddress,
            amount,
            metadataHash,
        );
        merkleTree.add(leafValue);
        const rootJSMainnet = merkleTree.getRoot();

        await expect(supernets2dot0BridgeContract.bridgeAsset(destinationNetwork, destinationAddress, amount, tokenAddress, true, '0x'))
            .to.emit(supernets2dot0BridgeContract, 'BridgeEvent')
            .withArgs(LEAF_TYPE_ASSET, originNetwork, tokenAddress, destinationNetwork, destinationAddress, amount, metadata, depositCount);

        expect(await supernets2dot0BridgeContract.getDepositRoot()).to.be.equal(rootJSMainnet);
    });

    it('should Supernets2dot0Bridge with weird token metadata with empty data', async () => {
        const weirdErc20Metadata = await ethers.getContractFactory('ERC20WeirdMetadata');

        const nameWeird = '';
        const symbolWeird = '';

        const nameWeirdBytes32 = ethers.utils.formatBytes32String(nameWeird);
        const symbolWeirdBytes = ethers.utils.toUtf8Bytes(symbolWeird);
        const decimalsWeird = 255;

        const weirdTokenContract = await weirdErc20Metadata.deploy(
            nameWeirdBytes32, // bytes32
            symbolWeirdBytes, // bytes
            decimalsWeird,
        );
        await weirdTokenContract.deployed();

        // mint and approve tokens
        await weirdTokenContract.mint(deployer.address, tokenInitialBalance);
        await weirdTokenContract.approve(supernets2dot0BridgeContract.address, tokenInitialBalance);

        const depositCount = await supernets2dot0BridgeContract.depositCount();
        const originNetwork = networkIDMainnet;
        const tokenAddress = weirdTokenContract.address;
        const amount = ethers.utils.parseEther('10');
        const destinationNetwork = networkIDRollup;
        const destinationAddress = deployer.address;

        // Empty bytes32 is a not valid encoding
        const nameEmpty = 'NOT_VALID_ENCODING'; // bytes32 empty
        const symbolEmpty = '';

        const metadata = ethers.utils.defaultAbiCoder.encode(
            ['string', 'string', 'uint8'],
            [nameEmpty, symbolEmpty, decimalsWeird],
        );

        const metadataHash = ethers.utils.solidityKeccak256(['bytes'], [metadata]);

        // pre compute root merkle tree in Js
        const height = 32;
        const merkleTree = new MerkleTreeBridge(height);
        const leafValue = getLeafValue(
            LEAF_TYPE_ASSET,
            originNetwork,
            tokenAddress,
            destinationNetwork,
            destinationAddress,
            amount,
            metadataHash,
        );
        merkleTree.add(leafValue);
        const rootJSMainnet = merkleTree.getRoot();

        await expect(supernets2dot0BridgeContract.bridgeAsset(destinationNetwork, destinationAddress, amount, tokenAddress, true, '0x'))
            .to.emit(supernets2dot0BridgeContract, 'BridgeEvent')
            .withArgs(LEAF_TYPE_ASSET, originNetwork, tokenAddress, destinationNetwork, destinationAddress, amount, metadata, depositCount);

        expect(await supernets2dot0BridgeContract.getDepositRoot()).to.be.equal(rootJSMainnet);
    });
});
