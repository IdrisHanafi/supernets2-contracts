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

describe('PolygonZkEVMBridge Mock Contract', () => {
    let deployer;
    let rollup;
    let acc1;

    let PolygonZkEVMGlobalExitRoot;
    let PolygonZkEVMBridgeContract;
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
        const PolygonZkEVMGlobalExitRootFactory = await ethers.getContractFactory('PolygonZkEVMGlobalExitRootMock');

        // deploy PolygonZkEVMBridge
        const PolygonZkEVMBridgeFactory = await ethers.getContractFactory('PolygonZkEVMBridgeMock');
        PolygonZkEVMBridgeContract = await upgrades.deployProxy(PolygonZkEVMBridgeFactory, [], { initializer: false });

        PolygonZkEVMGlobalExitRoot = await PolygonZkEVMGlobalExitRootFactory.deploy(rollup.address, PolygonZkEVMBridgeContract.address);
        await PolygonZkEVMBridgeContract.initialize(networkIDMainnet, PolygonZkEVMGlobalExitRoot.address, supernets2Address);

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
        expect(await PolygonZkEVMBridgeContract.globalExitRootManager()).to.be.equal(PolygonZkEVMGlobalExitRoot.address);
        expect(await PolygonZkEVMBridgeContract.networkID()).to.be.equal(networkIDMainnet);
    });

    it('should PolygonZkEVMBridge and verify merkle proof', async () => {
        const depositCount = await PolygonZkEVMBridgeContract.depositCount();
        const originNetwork = networkIDMainnet;
        const tokenAddress = tokenContract.address;
        const amount = ethers.utils.parseEther('10');
        const destinationNetwork = networkIDRollup;
        const destinationAddress = deployer.address;

        const metadata = metadataToken;
        const metadataHash = ethers.utils.solidityKeccak256(['bytes'], [metadata]);

        const balanceDeployer = await tokenContract.balanceOf(deployer.address);
        const balanceBridge = await tokenContract.balanceOf(PolygonZkEVMBridgeContract.address);

        const rollupExitRoot = await PolygonZkEVMGlobalExitRoot.lastRollupExitRoot();

        // create a new deposit
        await expect(tokenContract.approve(PolygonZkEVMBridgeContract.address, amount))
            .to.emit(tokenContract, 'Approval')
            .withArgs(deployer.address, PolygonZkEVMBridgeContract.address, amount);

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

        await expect(PolygonZkEVMBridgeContract.bridgeAsset(destinationNetwork, destinationAddress, amount, tokenAddress, true, '0x'))
            .to.emit(PolygonZkEVMBridgeContract, 'BridgeEvent')
            .withArgs(originNetwork, tokenAddress, destinationNetwork, destinationAddress, amount, metadata, depositCount)
            .to.emit(PolygonZkEVMGlobalExitRoot, 'UpdateGlobalExitRoot')
            .withArgs(rootJSMainnet, rollupExitRoot);

        expect(await tokenContract.balanceOf(deployer.address)).to.be.equal(balanceDeployer.sub(amount));
        expect(await tokenContract.balanceOf(PolygonZkEVMBridgeContract.address)).to.be.equal(balanceBridge.add(amount));

        // check merkle root with SC
        const rootSCMainnet = await PolygonZkEVMBridgeContract.getDepositRoot();
        expect(rootSCMainnet).to.be.equal(rootJSMainnet);

        // check merkle proof
        const proof = merkleTree.getProofTreeByIndex(0);
        const index = 0;

        // verify merkle proof
        expect(verifyMerkleProof(leafValue, proof, index, rootSCMainnet)).to.be.equal(true);
        expect(await PolygonZkEVMBridgeContract.verifyMerkleProof(
            leafValue,
            proof,
            index,
            rootSCMainnet,
        )).to.be.equal(true);

        const computedGlobalExitRoot = calculateGlobalExitRoot(rootJSMainnet, rollupExitRoot);
        expect(computedGlobalExitRoot).to.be.equal(await PolygonZkEVMGlobalExitRoot.getLastGlobalExitRoot());
    });

    it('shouldnt be able to PolygonZkEVMBridge more thna 0.25e ehters', async () => {
        // Add a claim leaf to rollup exit tree
        const tokenAddress = ethers.constants.AddressZero; // ether
        const amount = ethers.utils.parseEther('10');
        const destinationNetwork = networkIDRollup;
        const destinationAddress = deployer.address;

        await expect(PolygonZkEVMBridgeContract.bridgeAsset(
            destinationNetwork,
            destinationAddress,
            amount,
            tokenAddress,
            true,
            '0x',
            { value: ethers.utils.parseEther('10') },
        )).to.be.revertedWith('PolygonZkEVMBridge::bridgeAsset: Cannot bridge more than maxEtherBridge');

        await PolygonZkEVMBridgeContract.bridgeAsset(
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
        await PolygonZkEVMBridgeContract.setNetworkID(1);

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
        await PolygonZkEVMGlobalExitRoot.setGlobalExitRoot(computedGlobalExitRoot, 1);

        // check merkle proof
        const proof = merkleTree.getProofTreeByIndex(0);
        const index = 0;

        // verify merkle proof
        expect(verifyMerkleProof(leafValue, proof, index, mainnetExitRoot)).to.be.equal(true);
        expect(await PolygonZkEVMBridgeContract.verifyMerkleProof(
            leafValue,
            proof,
            index,
            mainnetExitRoot,
        )).to.be.equal(true);

        // transfer tokens, then claim
        await expect(tokenContract.transfer(PolygonZkEVMBridgeContract.address, amount))
            .to.emit(tokenContract, 'Transfer')
            .withArgs(deployer.address, PolygonZkEVMBridgeContract.address, amount);

        expect(false).to.be.equal(await PolygonZkEVMBridgeContract.isClaimed(index));

        await expect(PolygonZkEVMBridgeContract.claimAsset(
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
            .to.emit(PolygonZkEVMBridgeContract, 'ClaimEvent')
            .withArgs(
                index,
                originNetwork,
                tokenAddress,
                destinationAddress,
                amount,
            ).to.emit(tokenContract, 'Transfer')
            .withArgs(PolygonZkEVMBridgeContract.address, acc1.address, amount);

        // Can't claim because nullifier
        await expect(PolygonZkEVMBridgeContract.claimAsset(
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
        expect(true).to.be.equal(await PolygonZkEVMBridgeContract.isClaimed(index));
    });
});
