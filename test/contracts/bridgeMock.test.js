const { expect } = require('chai');
const { ethers, upgrades } = require('hardhat');
const MerkleTreeBridge = require('@0xpolygonhermez/zkevm-commonjs').MTBridge;
const {
    verifyMerkleProof,
    getLeafValue,
} = require('@0xpolygonhermez/zkevm-commonjs').mtBridgeUtils;

function calculateGlobalExitRoot(mainnetExitRoot, rollupExitRoot) {
    return ethers.utils.solidityKeccak256(['bytes32', 'bytes32'], [mainnetExitRoot, rollupExitRoot]);
}

describe('Supernets2Bridge Mock Contract', () => {
    let deployer;
    let rollup;
    let acc1;

    let supernets2GlobalExitRoot;
    let supernets2BridgeContract;
    let tokenContract;

    const tokenName = 'Matic Token';
    const tokenSymbol = 'MATIC';
    const decimals = 18;
    const tokenInitialBalance = ethers.utils.parseEther('20000000');
    const metadataToken = ethers.utils.defaultAbiCoder.encode(
        ['string', 'string', 'uint8'],
        [tokenName, tokenSymbol, decimals],
    );

    const networkIDMainnet = 0;
    const networkIDRollup = 1;

    const LEAF_TYPE_ASSET = 0;
    const supernets2Address = ethers.constants.AddressZero;

    beforeEach('Deploy contracts', async () => {
        // load signers
        [deployer, rollup, acc1] = await ethers.getSigners();

        // deploy global exit root manager
        const Supernets2GlobalExitRootFactory = await ethers.getContractFactory('Supernets2GlobalExitRootMock');

        // deploy Supernets2Bridge
        const supernets2BridgeFactory = await ethers.getContractFactory('Supernets2BridgeMock');
        supernets2BridgeContract = await upgrades.deployProxy(supernets2BridgeFactory, [], { initializer: false });

        supernets2GlobalExitRoot = await Supernets2GlobalExitRootFactory.deploy(rollup.address, supernets2BridgeContract.address);
        await supernets2BridgeContract.initialize(networkIDMainnet, supernets2GlobalExitRoot.address, supernets2Address);

        // deploy token
        const maticTokenFactory = await ethers.getContractFactory('ERC20PermitMock');
        tokenContract = await maticTokenFactory.deploy(
            tokenName,
            tokenSymbol,
            deployer.address,
            tokenInitialBalance,
        );
        await tokenContract.deployed();
    });

    it('should check the constructor parameters', async () => {
        expect(await supernets2BridgeContract.globalExitRootManager()).to.be.equal(supernets2GlobalExitRoot.address);
        expect(await supernets2BridgeContract.networkID()).to.be.equal(networkIDMainnet);
    });

    it('should Supernets2Bridge and verify merkle proof', async () => {
        const depositCount = await supernets2BridgeContract.depositCount();
        const originNetwork = networkIDMainnet;
        const tokenAddress = tokenContract.address;
        const amount = ethers.utils.parseEther('10');
        const destinationNetwork = networkIDRollup;
        const destinationAddress = deployer.address;

        const metadata = metadataToken;
        const metadataHash = ethers.utils.solidityKeccak256(['bytes'], [metadata]);

        const balanceDeployer = await tokenContract.balanceOf(deployer.address);
        const balanceBridge = await tokenContract.balanceOf(supernets2BridgeContract.address);

        const rollupExitRoot = await supernets2GlobalExitRoot.lastRollupExitRoot();

        // create a new deposit
        await expect(tokenContract.approve(supernets2BridgeContract.address, amount))
            .to.emit(tokenContract, 'Approval')
            .withArgs(deployer.address, supernets2BridgeContract.address, amount);

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

        await expect(supernets2BridgeContract.bridgeAsset(destinationNetwork, destinationAddress, amount, tokenAddress, true, '0x'))
            .to.emit(supernets2BridgeContract, 'BridgeEvent')
            .withArgs(originNetwork, tokenAddress, destinationNetwork, destinationAddress, amount, metadata, depositCount)
            .to.emit(supernets2GlobalExitRoot, 'UpdateGlobalExitRoot')
            .withArgs(rootJSMainnet, rollupExitRoot);

        expect(await tokenContract.balanceOf(deployer.address)).to.be.equal(balanceDeployer.sub(amount));
        expect(await tokenContract.balanceOf(supernets2BridgeContract.address)).to.be.equal(balanceBridge.add(amount));

        // check merkle root with SC
        const rootSCMainnet = await supernets2BridgeContract.getDepositRoot();
        expect(rootSCMainnet).to.be.equal(rootJSMainnet);

        // check merkle proof
        const proof = merkleTree.getProofTreeByIndex(0);
        const index = 0;

        // verify merkle proof
        expect(verifyMerkleProof(leafValue, proof, index, rootSCMainnet)).to.be.equal(true);
        expect(await supernets2BridgeContract.verifyMerkleProof(
            leafValue,
            proof,
            index,
            rootSCMainnet,
        )).to.be.equal(true);

        const computedGlobalExitRoot = calculateGlobalExitRoot(rootJSMainnet, rollupExitRoot);
        expect(computedGlobalExitRoot).to.be.equal(await supernets2GlobalExitRoot.getLastGlobalExitRoot());
    });

    it('shouldnt be able to Supernets2Bridge more thna 0.25e ehters', async () => {
        // Add a claim leaf to rollup exit tree
        const tokenAddress = ethers.constants.AddressZero; // ether
        const amount = ethers.utils.parseEther('10');
        const destinationNetwork = networkIDRollup;
        const destinationAddress = deployer.address;

        await expect(supernets2BridgeContract.bridgeAsset(
            destinationNetwork,
            destinationAddress,
            amount,
            tokenAddress,
            true,
            '0x',
            { value: ethers.utils.parseEther('10') },
        )).to.be.revertedWith('Supernets2Bridge::bridgeAsset: Cannot bridge more than maxEtherBridge');

        await supernets2BridgeContract.bridgeAsset(
            destinationNetwork,
            destinationAddress,
            ethers.utils.parseEther('0.25'),
            tokenAddress,
            true,
            '0x',
            { value: ethers.utils.parseEther('0.25') },
        );
    });

    it('should claim tokens from Rollup to Rollup', async () => {
        const originNetwork = networkIDRollup;
        const tokenAddress = tokenContract.address;
        const amount = ethers.utils.parseEther('10');
        const destinationNetwork = networkIDRollup;
        const destinationAddress = acc1.address;

        const metadata = metadataToken;
        const metadataHash = ethers.utils.solidityKeccak256(['bytes'], [metadata]);

        // Set network to Rollup
        await supernets2BridgeContract.setNetworkID(1);

        // compute root merkle tree in Js
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

        // check merkle root with SC
        const mainnetExitRoot = merkleTree.getRoot();
        const rollupExitRoot = ethers.constants.HashZero;

        const computedGlobalExitRoot = calculateGlobalExitRoot(mainnetExitRoot, rollupExitRoot);
        // set globalExitRoot
        await supernets2GlobalExitRoot.setGlobalExitRoot(computedGlobalExitRoot, 1);

        // check merkle proof
        const proof = merkleTree.getProofTreeByIndex(0);
        const index = 0;

        // verify merkle proof
        expect(verifyMerkleProof(leafValue, proof, index, mainnetExitRoot)).to.be.equal(true);
        expect(await supernets2BridgeContract.verifyMerkleProof(
            leafValue,
            proof,
            index,
            mainnetExitRoot,
        )).to.be.equal(true);

        // transfer tokens, then claim
        await expect(tokenContract.transfer(supernets2BridgeContract.address, amount))
            .to.emit(tokenContract, 'Transfer')
            .withArgs(deployer.address, supernets2BridgeContract.address, amount);

        expect(false).to.be.equal(await supernets2BridgeContract.isClaimed(index));

        await expect(supernets2BridgeContract.claimAsset(
            proof,
            index,
            mainnetExitRoot,
            rollupExitRoot,
            originNetwork,
            tokenAddress,
            destinationNetwork,
            destinationAddress,
            amount,
            metadata,
        ))
            .to.emit(supernets2BridgeContract, 'ClaimEvent')
            .withArgs(
                index,
                originNetwork,
                tokenAddress,
                destinationAddress,
                amount,
            ).to.emit(tokenContract, 'Transfer')
            .withArgs(supernets2BridgeContract.address, acc1.address, amount);

        // Can't claim because nullifier
        await expect(supernets2BridgeContract.claimAsset(
            proof,
            index,
            mainnetExitRoot,
            rollupExitRoot,
            originNetwork,
            tokenAddress,
            destinationNetwork,
            destinationAddress,
            amount,
            metadata,
        )).to.be.revertedWith('AlreadyClaimed');
        expect(true).to.be.equal(await supernets2BridgeContract.isClaimed(index));
    });
});
