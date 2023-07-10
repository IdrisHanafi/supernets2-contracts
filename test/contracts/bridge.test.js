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

describe('PolygonZkEVMBridge Contract', () => {
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
    const LEAF_TYPE_MESSAGE = 1;

    const supernets2Address = ethers.constants.AddressZero;

    beforeEach('Deploy contracts', async () => {
        // load signers
        [deployer, rollup, acc1] = await ethers.getSigners();

        // deploy PolygonZkEVMBridge
        const PolygonZkEVMBridgeFactory = await ethers.getContractFactory('PolygonZkEVMBridge');
        PolygonZkEVMBridgeContract = await upgrades.deployProxy(PolygonZkEVMBridgeFactory, [], { initializer: false });

        // deploy global exit root manager
        const PolygonZkEVMGlobalExitRootFactory = await ethers.getContractFactory('PolygonZkEVMGlobalExitRoot');
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
        expect(await PolygonZkEVMBridgeContract.supernets2address()).to.be.equal(supernets2Address);
    });

    it('should Supernets2 bridge asset and verify merkle proof', async () => {
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

        // check requires
        await expect(PolygonZkEVMBridgeContract.bridgeAsset(
            2,
            destinationAddress,
            amount,
            tokenAddress,
            true,
            '0x',
        )).to.be.revertedWith('DestinationNetworkInvalid');

        await expect(PolygonZkEVMBridgeContract.bridgeAsset(
            destinationNetwork,
            destinationAddress,
            amount,
            tokenAddress,
            true,
            '0x',
            { value: 1 },
        )).to.be.revertedWith('MsgValueNotZero');

        await expect(PolygonZkEVMBridgeContract.bridgeAsset(destinationNetwork, destinationAddress, amount, tokenAddress, true, '0x'))
            .to.emit(PolygonZkEVMBridgeContract, 'BridgeEvent')
            .withArgs(LEAF_TYPE_ASSET, originNetwork, tokenAddress, destinationNetwork, destinationAddress, amount, metadata, depositCount)
            .to.emit(PolygonZkEVMGlobalExitRoot, 'UpdateGlobalExitRoot')
            .withArgs(rootJSMainnet, rollupExitRoot);

        expect(await tokenContract.balanceOf(deployer.address)).to.be.equal(balanceDeployer.sub(amount));
        expect(await tokenContract.balanceOf(PolygonZkEVMBridgeContract.address)).to.be.equal(balanceBridge.add(amount));
        expect(await PolygonZkEVMBridgeContract.lastUpdatedDepositCount()).to.be.equal(1);

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

    it('should PolygonZkEVMBridge message and verify merkle proof', async () => {
        const depositCount = await PolygonZkEVMBridgeContract.depositCount();
        const originNetwork = networkIDMainnet;
        const originAddress = deployer.address;
        const amount = ethers.utils.parseEther('10');
        const destinationNetwork = networkIDRollup;
        const destinationAddress = deployer.address;

        const metadata = metadataToken;
        const metadataHash = ethers.utils.solidityKeccak256(['bytes'], [metadata]);
        const rollupExitRoot = await PolygonZkEVMGlobalExitRoot.lastRollupExitRoot();

        // pre compute root merkle tree in Js
        const height = 32;
        const merkleTree = new MerkleTreeBridge(height);
        const leafValue = getLeafValue(
            LEAF_TYPE_MESSAGE,
            originNetwork,
            originAddress,
            destinationNetwork,
            destinationAddress,
            amount,
            metadataHash,
        );
        merkleTree.add(leafValue);
        const rootJSMainnet = merkleTree.getRoot();

        await expect(PolygonZkEVMBridgeContract.bridgeMessage(destinationNetwork, destinationAddress, true, metadata, { value: amount }))
            .to.emit(PolygonZkEVMBridgeContract, 'BridgeEvent')
            .withArgs(
                LEAF_TYPE_MESSAGE,
                originNetwork,
                originAddress,
                destinationNetwork,
                destinationAddress,
                amount,
                metadata,
                depositCount,
            );

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

    it('should Supernets2 bridge asset and message to check global exit root updates', async () => {
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

        await expect(PolygonZkEVMBridgeContract.bridgeAsset(destinationNetwork, destinationAddress, amount, tokenAddress, false, '0x'))
            .to.emit(PolygonZkEVMBridgeContract, 'BridgeEvent')
            .withArgs(LEAF_TYPE_ASSET, originNetwork, tokenAddress, destinationNetwork, destinationAddress, amount, metadata, depositCount);

        expect(await tokenContract.balanceOf(deployer.address)).to.be.equal(balanceDeployer.sub(amount));
        expect(await tokenContract.balanceOf(PolygonZkEVMBridgeContract.address)).to.be.equal(balanceBridge.add(amount));
        expect(await PolygonZkEVMBridgeContract.lastUpdatedDepositCount()).to.be.equal(0);
        expect(await PolygonZkEVMGlobalExitRoot.lastMainnetExitRoot()).to.be.equal(ethers.constants.HashZero);

        // check merkle root with SC
        const rootSCMainnet = await PolygonZkEVMBridgeContract.getDepositRoot();
        expect(rootSCMainnet).to.be.equal(rootJSMainnet);

        // Update global exit root
        await expect(PolygonZkEVMBridgeContract.updateGlobalExitRoot())
            .to.emit(PolygonZkEVMGlobalExitRoot, 'UpdateGlobalExitRoot')
            .withArgs(rootJSMainnet, rollupExitRoot);

        // no state changes since there are not any deposit pending to be updated
        await PolygonZkEVMBridgeContract.updateGlobalExitRoot();
        expect(await PolygonZkEVMBridgeContract.lastUpdatedDepositCount()).to.be.equal(1);
        expect(await PolygonZkEVMGlobalExitRoot.lastMainnetExitRoot()).to.be.equal(rootJSMainnet);

        const computedGlobalExitRoot = calculateGlobalExitRoot(rootJSMainnet, rollupExitRoot);
        expect(computedGlobalExitRoot).to.be.equal(await PolygonZkEVMGlobalExitRoot.getLastGlobalExitRoot());

        // bridge message
        await expect(PolygonZkEVMBridgeContract.bridgeMessage(destinationNetwork, destinationAddress, false, metadata, { value: amount }))
            .to.emit(PolygonZkEVMBridgeContract, 'BridgeEvent')
            .withArgs(
                LEAF_TYPE_MESSAGE,
                originNetwork,
                deployer.address,
                destinationNetwork,
                destinationAddress,
                amount,
                metadata,
                1,
            );
        expect(await PolygonZkEVMBridgeContract.lastUpdatedDepositCount()).to.be.equal(1);
        expect(await PolygonZkEVMGlobalExitRoot.lastMainnetExitRoot()).to.be.equal(rootJSMainnet);

        // Update global exit root
        await expect(PolygonZkEVMBridgeContract.updateGlobalExitRoot())
            .to.emit(PolygonZkEVMGlobalExitRoot, 'UpdateGlobalExitRoot');

        expect(await PolygonZkEVMBridgeContract.lastUpdatedDepositCount()).to.be.equal(2);
        expect(await PolygonZkEVMGlobalExitRoot.lastMainnetExitRoot()).to.not.be.equal(rootJSMainnet);

        // Just to have the metric of a low cost bridge Asset
        const tokenAddress2 = ethers.constants.AddressZero; // Ether
        const amount2 = ethers.utils.parseEther('10');
        await PolygonZkEVMBridgeContract.bridgeAsset(destinationNetwork, destinationAddress, amount2, tokenAddress2, false, '0x', { value: amount2 });
    });

    it('should claim tokens from Mainnet to Mainnet', async () => {
        const originNetwork = networkIDMainnet;
        const tokenAddress = tokenContract.address;
        const amount = ethers.utils.parseEther('10');
        const destinationNetwork = networkIDMainnet;
        const destinationAddress = acc1.address;

        const metadata = metadataToken;
        const metadataHash = ethers.utils.solidityKeccak256(['bytes'], [metadata]);

        const mainnetExitRoot = await PolygonZkEVMGlobalExitRoot.lastMainnetExitRoot();

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
        const rootJSRollup = merkleTree.getRoot();

        // check only rollup account with update rollup exit root
        await expect(PolygonZkEVMGlobalExitRoot.updateExitRoot(rootJSRollup))
            .to.be.revertedWith('OnlyAllowedContracts');

        // add rollup Merkle root
        await expect(PolygonZkEVMGlobalExitRoot.connect(rollup).updateExitRoot(rootJSRollup))
            .to.emit(PolygonZkEVMGlobalExitRoot, 'UpdateGlobalExitRoot')
            .withArgs(mainnetExitRoot, rootJSRollup);

        // check roots
        const rollupExitRootSC = await PolygonZkEVMGlobalExitRoot.lastRollupExitRoot();
        expect(rollupExitRootSC).to.be.equal(rootJSRollup);

        const computedGlobalExitRoot = calculateGlobalExitRoot(mainnetExitRoot, rollupExitRootSC);
        expect(computedGlobalExitRoot).to.be.equal(await PolygonZkEVMGlobalExitRoot.getLastGlobalExitRoot());

        // check merkle proof
        const proof = merkleTree.getProofTreeByIndex(0);
        const index = 0;

        // verify merkle proof
        expect(verifyMerkleProof(leafValue, proof, index, rootJSRollup)).to.be.equal(true);
        expect(await PolygonZkEVMBridgeContract.verifyMerkleProof(
            leafValue,
            proof,
            index,
            rootJSRollup,
        )).to.be.equal(true);

        /*
         * claim
         * Can't claim without tokens
         */
        await expect(PolygonZkEVMBridgeContract.claimAsset(
            proof,
            index,
            mainnetExitRoot,
            rollupExitRootSC,
            originNetwork,
            tokenAddress,
            destinationNetwork,
            destinationAddress,
            amount,
            metadata,
        )).to.be.revertedWith('ERC20: transfer amount exceeds balance');

        // transfer tokens, then claim
        await expect(tokenContract.transfer(PolygonZkEVMBridgeContract.address, amount))
            .to.emit(tokenContract, 'Transfer')
            .withArgs(deployer.address, PolygonZkEVMBridgeContract.address, amount);

        expect(false).to.be.equal(await PolygonZkEVMBridgeContract.isClaimed(index));

        await expect(PolygonZkEVMBridgeContract.claimAsset(
            proof,
            index,
            mainnetExitRoot,
            rollupExitRootSC,
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
            rollupExitRootSC,
            originNetwork,
            tokenAddress,
            destinationNetwork,
            destinationAddress,
            amount,
            metadata,
        )).to.be.revertedWith('AlreadyClaimed');
        expect(true).to.be.equal(await PolygonZkEVMBridgeContract.isClaimed(index));
    });

    it('should claim tokens from Rollup to Mainnet', async () => {
        const originNetwork = networkIDRollup;
        const tokenAddress = ethers.utils.getAddress(ethers.utils.hexlify(ethers.utils.randomBytes(20)));
        const amount = ethers.utils.parseEther('10');
        const destinationNetwork = networkIDMainnet;
        const destinationAddress = deployer.address;

        const metadata = metadataToken; // since we are inserting in the exit root can be anything
        const metadataHash = ethers.utils.solidityKeccak256(['bytes'], [metadata]);

        const mainnetExitRoot = await PolygonZkEVMGlobalExitRoot.lastMainnetExitRoot();

        // compute root merkle tree in Js
        const height = 32;
        const merkleTreeRollup = new MerkleTreeBridge(height);
        const leafValue = getLeafValue(
            LEAF_TYPE_ASSET,
            originNetwork,
            tokenAddress,
            destinationNetwork,
            destinationAddress,
            amount,
            metadataHash,
        );

        // Add 2 leafs
        merkleTreeRollup.add(leafValue);
        merkleTreeRollup.add(leafValue);

        // check merkle root with SC
        const rootJSRollup = merkleTreeRollup.getRoot();

        // check only rollup account with update rollup exit root
        await expect(PolygonZkEVMGlobalExitRoot.updateExitRoot(rootJSRollup))
            .to.be.revertedWith('OnlyAllowedContracts');

        // add rollup Merkle root
        await expect(PolygonZkEVMGlobalExitRoot.connect(rollup).updateExitRoot(rootJSRollup))
            .to.emit(PolygonZkEVMGlobalExitRoot, 'UpdateGlobalExitRoot')
            .withArgs(mainnetExitRoot, rootJSRollup);

        // check roots
        const rollupExitRootSC = await PolygonZkEVMGlobalExitRoot.lastRollupExitRoot();
        expect(rollupExitRootSC).to.be.equal(rootJSRollup);

        const computedGlobalExitRoot = calculateGlobalExitRoot(mainnetExitRoot, rollupExitRootSC);
        expect(computedGlobalExitRoot).to.be.equal(await PolygonZkEVMGlobalExitRoot.getLastGlobalExitRoot());

        // check merkle proof
        const proof = merkleTreeRollup.getProofTreeByIndex(0);
        const index = 0;

        // verify merkle proof
        expect(verifyMerkleProof(leafValue, proof, index, rootJSRollup)).to.be.equal(true);
        expect(await PolygonZkEVMBridgeContract.verifyMerkleProof(
            leafValue,
            proof,
            index,
            rootJSRollup,
        )).to.be.equal(true);

        // claim

        // precalculate wrapped erc20 address
        const tokenWrappedFactory = await ethers.getContractFactory('TokenWrapped');

        // create2 parameters
        const salt = ethers.utils.solidityKeccak256(['uint32', 'address'], [networkIDRollup, tokenAddress]);
        const minimalBytecodeProxy = tokenWrappedFactory.bytecode;
        const hashInitCode = ethers.utils.solidityKeccak256(['bytes', 'bytes'], [minimalBytecodeProxy, metadataToken]);
        const precalculateWrappedErc20 = await ethers.utils.getCreate2Address(PolygonZkEVMBridgeContract.address, salt, hashInitCode);
        const newWrappedToken = tokenWrappedFactory.attach(precalculateWrappedErc20);

        // Use precalculatedWrapperAddress and check if matches
        expect(await PolygonZkEVMBridgeContract.precalculatedWrapperAddress(
            networkIDRollup,
            tokenAddress,
            tokenName,
            tokenSymbol,
            decimals,
        )).to.be.equal(precalculateWrappedErc20);

        await expect(PolygonZkEVMBridgeContract.claimAsset(
            proof,
            index,
            mainnetExitRoot,
            rollupExitRootSC,
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
            ).to.emit(PolygonZkEVMBridgeContract, 'NewWrappedToken')
            .withArgs(originNetwork, tokenAddress, precalculateWrappedErc20, metadata)
            .to.emit(newWrappedToken, 'Transfer')
            .withArgs(ethers.constants.AddressZero, deployer.address, amount);

        // Assert maps created
        const newTokenInfo = await PolygonZkEVMBridgeContract.wrappedTokenToTokenInfo(precalculateWrappedErc20);

        expect(newTokenInfo.originNetwork).to.be.equal(networkIDRollup);
        expect(newTokenInfo.originTokenAddress).to.be.equal(tokenAddress);
        expect(await PolygonZkEVMBridgeContract.getTokenWrappedAddress(
            networkIDRollup,
            tokenAddress,
        )).to.be.equal(precalculateWrappedErc20);
        expect(await PolygonZkEVMBridgeContract.getTokenWrappedAddress(
            networkIDRollup,
            tokenAddress,
        )).to.be.equal(precalculateWrappedErc20);

        expect(await PolygonZkEVMBridgeContract.tokenInfoToWrappedToken(salt)).to.be.equal(precalculateWrappedErc20);

        // Check the wrapper info
        expect(await newWrappedToken.name()).to.be.equal(tokenName);
        expect(await newWrappedToken.symbol()).to.be.equal(tokenSymbol);
        expect(await newWrappedToken.decimals()).to.be.equal(decimals);

        // Can't claim because nullifier
        await expect(PolygonZkEVMBridgeContract.claimAsset(
            proof,
            index,
            mainnetExitRoot,
            rollupExitRootSC,
            originNetwork,
            tokenAddress,
            destinationNetwork,
            destinationAddress,
            amount,
            metadata,
        )).to.be.revertedWith('AlreadyClaimed');

        // Check new token
        expect(await newWrappedToken.totalSupply()).to.be.equal(amount);

        // Claim again the other leaf to mint tokens
        const index2 = 1;
        const proof2 = merkleTreeRollup.getProofTreeByIndex(index2);

        await expect(PolygonZkEVMBridgeContract.claimAsset(
            proof2,
            index2,
            mainnetExitRoot,
            rollupExitRootSC,
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
            ).to.emit(newWrappedToken, 'Transfer')
            .withArgs(ethers.constants.AddressZero, deployer.address, amount);

        // Burn Tokens
        const depositCount = await PolygonZkEVMBridgeContract.depositCount();
        const wrappedTokenAddress = newWrappedToken.address;
        const newDestinationNetwork = networkIDRollup;

        const rollupExitRoot = await PolygonZkEVMGlobalExitRoot.lastRollupExitRoot();

        // create a new deposit
        await expect(newWrappedToken.approve(PolygonZkEVMBridgeContract.address, amount))
            .to.emit(newWrappedToken, 'Approval')
            .withArgs(deployer.address, PolygonZkEVMBridgeContract.address, amount);

        /*
         *  pre compute root merkle tree in Js
         * const height = 32;
         */
        const merkleTreeMainnet = new MerkleTreeBridge(height);
        // Imporant calcualte leaf with origin token address no wrapped token address
        const originTokenAddress = tokenAddress;
        const metadataMainnet = '0x'; // since the token does not belong to this network
        const metadataHashMainnet = ethers.utils.solidityKeccak256(['bytes'], [metadataMainnet]);

        const leafValueMainnet = getLeafValue(
            LEAF_TYPE_ASSET,
            originNetwork,
            originTokenAddress,
            newDestinationNetwork,
            destinationAddress,
            amount,
            metadataHashMainnet,
        );
        const leafValueMainnetSC = await PolygonZkEVMBridgeContract.getLeafValue(
            LEAF_TYPE_ASSET,
            originNetwork,
            originTokenAddress,
            newDestinationNetwork,
            destinationAddress,
            amount,
            metadataHashMainnet,
        );

        expect(leafValueMainnet).to.be.equal(leafValueMainnetSC);
        merkleTreeMainnet.add(leafValueMainnet);
        const rootJSMainnet = merkleTreeMainnet.getRoot();

        // Tokens are burnt
        expect(await newWrappedToken.totalSupply()).to.be.equal(ethers.BigNumber.from(amount).mul(2));
        expect(await newWrappedToken.balanceOf(deployer.address)).to.be.equal(ethers.BigNumber.from(amount).mul(2));

        await expect(PolygonZkEVMBridgeContract.bridgeAsset(newDestinationNetwork, destinationAddress, amount, wrappedTokenAddress, true, '0x'))
            .to.emit(PolygonZkEVMBridgeContract, 'BridgeEvent')
            .withArgs(
                LEAF_TYPE_ASSET,
                originNetwork,
                originTokenAddress,
                newDestinationNetwork,
                destinationAddress,
                amount,
                metadataMainnet,
                depositCount,
            )
            .to.emit(PolygonZkEVMGlobalExitRoot, 'UpdateGlobalExitRoot')
            .withArgs(rootJSMainnet, rollupExitRoot)
            .to.emit(newWrappedToken, 'Transfer')
            .withArgs(deployer.address, ethers.constants.AddressZero, amount);

        expect(await newWrappedToken.totalSupply()).to.be.equal(amount);
        expect(await newWrappedToken.balanceOf(deployer.address)).to.be.equal(amount);
        expect(await newWrappedToken.balanceOf(PolygonZkEVMBridgeContract.address)).to.be.equal(0);

        // check merkle root with SC
        const rootSCMainnet = await PolygonZkEVMBridgeContract.getDepositRoot();
        expect(rootSCMainnet).to.be.equal(rootJSMainnet);

        // check merkle proof
        const proofMainnet = merkleTreeMainnet.getProofTreeByIndex(0);
        const indexMainnet = 0;

        // verify merkle proof
        expect(verifyMerkleProof(leafValueMainnet, proofMainnet, indexMainnet, rootSCMainnet)).to.be.equal(true);
        expect(await PolygonZkEVMBridgeContract.verifyMerkleProof(
            leafValueMainnet,
            proofMainnet,
            indexMainnet,
            rootSCMainnet,
        )).to.be.equal(true);

        const computedGlobalExitRoot2 = calculateGlobalExitRoot(rootJSMainnet, rollupExitRoot);
        expect(computedGlobalExitRoot2).to.be.equal(await PolygonZkEVMGlobalExitRoot.getLastGlobalExitRoot());
    });

    it('should PolygonZkEVMBridge and sync the current root with events', async () => {
        const depositCount = await PolygonZkEVMBridgeContract.depositCount();
        const originNetwork = networkIDMainnet;
        const tokenAddress = ethers.constants.AddressZero; // Ether
        const amount = ethers.utils.parseEther('10');
        const destinationNetwork = networkIDRollup;
        const destinationAddress = deployer.address;

        const metadata = '0x';// since is ether does not have metadata

        // create 3 new deposit
        await expect(PolygonZkEVMBridgeContract.bridgeAsset(
            destinationNetwork,
            destinationAddress,
            amount,
            tokenAddress,
            true,
            '0x',
            { value: amount },
        ))
            .to.emit(
                PolygonZkEVMBridgeContract,
                'BridgeEvent',
            )
            .withArgs(
                LEAF_TYPE_ASSET,
                originNetwork,
                tokenAddress,
                destinationNetwork,
                destinationAddress,
                amount,
                metadata,
                depositCount,
            );

        await expect(PolygonZkEVMBridgeContract.bridgeAsset(
            destinationNetwork,
            destinationAddress,
            amount,
            tokenAddress,
            true,
            '0x',
            { value: amount },
        ))
            .to.emit(
                PolygonZkEVMBridgeContract,
                'BridgeEvent',
            )
            .withArgs(
                LEAF_TYPE_ASSET,
                originNetwork,
                tokenAddress,
                destinationNetwork,
                destinationAddress,
                amount,
                metadata,
                depositCount.add(1),
            );

        await expect(PolygonZkEVMBridgeContract.bridgeAsset(
            destinationNetwork,
            destinationAddress,
            amount,
            tokenAddress,
            true,
            '0x',
            { value: amount },
        ))
            .to.emit(
                PolygonZkEVMBridgeContract,
                'BridgeEvent',
            )
            .withArgs(
                LEAF_TYPE_ASSET,
                originNetwork,
                tokenAddress,
                destinationNetwork,
                destinationAddress,
                amount,
                metadata,
                depositCount.add(2),
            );

        // Prepare merkle tree
        const height = 32;
        const merkleTree = new MerkleTreeBridge(height);

        // Get the deposit's events
        const filter = PolygonZkEVMBridgeContract.filters.BridgeEvent(
            null,
            null,
            null,
            null,
            null,
        );
        const events = await PolygonZkEVMBridgeContract.queryFilter(filter, 0, 'latest');
        events.forEach((e) => {
            const { args } = e;
            const leafValue = getLeafValue(
                args.leafType,
                args.originNetwork,
                args.originAddress,
                args.destinationNetwork,
                args.destinationAddress,
                args.amount,
                ethers.utils.solidityKeccak256(['bytes'], [args.metadata]),
            );
            merkleTree.add(leafValue);
        });

        // Check merkle root with SC
        const rootSC = await PolygonZkEVMBridgeContract.getDepositRoot();
        const rootJS = merkleTree.getRoot();

        expect(rootSC).to.be.equal(rootJS);
    });

    it('should claim testing all the asserts', async () => {
        // Add a claim leaf to rollup exit tree
        const originNetwork = networkIDMainnet;
        const tokenAddress = tokenContract.address;
        const amount = ethers.utils.parseEther('10');
        const destinationNetwork = networkIDMainnet;
        const destinationAddress = deployer.address;

        const metadata = metadataToken;
        const metadataHash = ethers.utils.solidityKeccak256(['bytes'], [metadata]);

        const mainnetExitRoot = await PolygonZkEVMGlobalExitRoot.lastMainnetExitRoot();

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
        const rootJSRollup = merkleTree.getRoot();

        // add rollup Merkle root
        await expect(PolygonZkEVMGlobalExitRoot.connect(rollup).updateExitRoot(rootJSRollup))
            .to.emit(PolygonZkEVMGlobalExitRoot, 'UpdateGlobalExitRoot')
            .withArgs(mainnetExitRoot, rootJSRollup);

        // check roots
        const rollupExitRootSC = await PolygonZkEVMGlobalExitRoot.lastRollupExitRoot();
        expect(rollupExitRootSC).to.be.equal(rootJSRollup);

        const computedGlobalExitRoot = calculateGlobalExitRoot(mainnetExitRoot, rollupExitRootSC);
        expect(computedGlobalExitRoot).to.be.equal(await PolygonZkEVMGlobalExitRoot.getLastGlobalExitRoot());

        // check merkle proof
        const proof = merkleTree.getProofTreeByIndex(0);
        const index = 0;

        // verify merkle proof
        expect(verifyMerkleProof(leafValue, proof, index, rootJSRollup)).to.be.equal(true);
        expect(await PolygonZkEVMBridgeContract.verifyMerkleProof(
            leafValue,
            proof,
            index,
            rootJSRollup,
        )).to.be.equal(true);

        // Can't claim without tokens
        await expect(PolygonZkEVMBridgeContract.claimAsset(
            proof,
            index,
            mainnetExitRoot,
            rollupExitRootSC,
            originNetwork,
            tokenAddress,
            destinationNetwork,
            destinationAddress,
            amount,
            metadata,
        )).to.be.revertedWith('ERC20: transfer amount exceeds balance');

        // transfer tokens, then claim
        await expect(tokenContract.transfer(PolygonZkEVMBridgeContract.address, amount))
            .to.emit(tokenContract, 'Transfer')
            .withArgs(deployer.address, PolygonZkEVMBridgeContract.address, amount);

        // Check Destination network does not match assert
        await expect(PolygonZkEVMBridgeContract.claimAsset(
            proof,
            index,
            mainnetExitRoot,
            rollupExitRootSC,
            originNetwork,
            tokenAddress,
            networkIDRollup, // Wrong destination network
            destinationAddress,
            amount,
            metadata,
        )).to.be.revertedWith('DestinationNetworkInvalid');

        // Check GlobalExitRoot invalid assert
        await expect(PolygonZkEVMBridgeContract.claimAsset(
            proof,
            index,
            mainnetExitRoot,
            mainnetExitRoot, // Wrong rollup Root
            originNetwork,
            tokenAddress,
            destinationNetwork,
            destinationAddress,
            amount,
            metadata,
        )).to.be.revertedWith('GlobalExitRootInvalid');

        // Check Invalid smt proof assert
        await expect(PolygonZkEVMBridgeContract.claimAsset(
            proof,
            index + 1, // Wrong index
            mainnetExitRoot,
            rollupExitRootSC,
            originNetwork,
            tokenAddress,
            destinationNetwork,
            destinationAddress,
            amount,
            metadata,
        )).to.be.revertedWith('InvalidSmtProof');

        await expect(PolygonZkEVMBridgeContract.claimAsset(
            proof,
            index,
            mainnetExitRoot,
            rollupExitRootSC,
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
            .withArgs(PolygonZkEVMBridgeContract.address, deployer.address, amount);

        // Check Already claimed_claim
        await expect(PolygonZkEVMBridgeContract.claimAsset(
            proof,
            index,
            mainnetExitRoot,
            rollupExitRootSC,
            originNetwork,
            tokenAddress,
            destinationNetwork,
            destinationAddress,
            amount,
            metadata,
        )).to.be.revertedWith('AlreadyClaimed');
    });

    it('should claim ether', async () => {
        // Add a claim leaf to rollup exit tree
        const originNetwork = networkIDMainnet;
        const tokenAddress = ethers.constants.AddressZero; // ether
        const amount = ethers.utils.parseEther('10');
        const destinationNetwork = networkIDMainnet;
        const destinationAddress = deployer.address;

        const metadata = '0x'; // since is ether does not have metadata
        const metadataHash = ethers.utils.solidityKeccak256(['bytes'], [metadata]);

        const mainnetExitRoot = await PolygonZkEVMGlobalExitRoot.lastMainnetExitRoot();

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
        const rootJSRollup = merkleTree.getRoot();

        // add rollup Merkle root
        await expect(PolygonZkEVMGlobalExitRoot.connect(rollup).updateExitRoot(rootJSRollup))
            .to.emit(PolygonZkEVMGlobalExitRoot, 'UpdateGlobalExitRoot')
            .withArgs(mainnetExitRoot, rootJSRollup);

        // check roots
        const rollupExitRootSC = await PolygonZkEVMGlobalExitRoot.lastRollupExitRoot();
        expect(rollupExitRootSC).to.be.equal(rootJSRollup);

        const computedGlobalExitRoot = calculateGlobalExitRoot(mainnetExitRoot, rollupExitRootSC);
        expect(computedGlobalExitRoot).to.be.equal(await PolygonZkEVMGlobalExitRoot.getLastGlobalExitRoot());

        // check merkle proof
        const proof = merkleTree.getProofTreeByIndex(0);
        const index = 0;

        // verify merkle proof
        expect(verifyMerkleProof(leafValue, proof, index, rootJSRollup)).to.be.equal(true);
        expect(await PolygonZkEVMBridgeContract.verifyMerkleProof(
            leafValue,
            proof,
            index,
            rootJSRollup,
        )).to.be.equal(true);

        /*
         * claim
         * Can't claim without ether
         */
        await expect(PolygonZkEVMBridgeContract.claimAsset(
            proof,
            index,
            mainnetExitRoot,
            rollupExitRootSC,
            originNetwork,
            tokenAddress,
            destinationNetwork,
            destinationAddress,
            amount,
            metadata,
        )).to.be.revertedWith('EtherTransferFailed');

        const balanceDeployer = await ethers.provider.getBalance(deployer.address);
        /*
         * Create a deposit to add ether to the PolygonZkEVMBridge
         * Check deposit amount ether asserts
         */
        await expect(PolygonZkEVMBridgeContract.bridgeAsset(
            networkIDRollup,
            destinationAddress,
            amount,
            tokenAddress,
            true,
            '0x',
            { value: ethers.utils.parseEther('100') },
        )).to.be.revertedWith('AmountDoesNotMatchMsgValue');

        // Check mainnet destination assert
        await expect(PolygonZkEVMBridgeContract.bridgeAsset(
            networkIDMainnet,
            destinationAddress,
            amount,
            tokenAddress,
            true,
            '0x',
            { value: amount },
        )).to.be.revertedWith('DestinationNetworkInvalid');

        // This is used just to pay ether to the PolygonZkEVMBridge smart contract and be able to claim it afterwards.
        expect(await PolygonZkEVMBridgeContract.bridgeAsset(
            networkIDRollup,
            destinationAddress,
            amount,
            tokenAddress,
            true,
            '0x',
            { value: amount },
        ));

        // Check balances before claim
        expect(await ethers.provider.getBalance(PolygonZkEVMBridgeContract.address)).to.be.equal(amount);
        expect(await ethers.provider.getBalance(deployer.address)).to.be.lte(balanceDeployer.sub(amount));

        await expect(PolygonZkEVMBridgeContract.claimAsset(
            proof,
            index,
            mainnetExitRoot,
            rollupExitRootSC,
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
            );

        // Check balances after claim
        expect(await ethers.provider.getBalance(PolygonZkEVMBridgeContract.address)).to.be.equal(ethers.utils.parseEther('0'));
        expect(await ethers.provider.getBalance(deployer.address)).to.be.lte(balanceDeployer);

        // Can't claim because nullifier
        await expect(PolygonZkEVMBridgeContract.claimAsset(
            proof,
            index,
            mainnetExitRoot,
            rollupExitRootSC,
            originNetwork,
            tokenAddress,
            destinationNetwork,
            destinationAddress,
            amount,
            metadata,
        )).to.be.revertedWith('AlreadyClaimed');
    });

    it('should claim message', async () => {
        // Add a claim leaf to rollup exit tree
        const originNetwork = networkIDMainnet;
        const tokenAddress = ethers.constants.AddressZero; // ether
        const amount = ethers.utils.parseEther('10');
        const destinationNetwork = networkIDMainnet;
        const destinationAddress = deployer.address;

        const metadata = '0x176923791298713271763697869132'; // since is ether does not have metadata
        const metadataHash = ethers.utils.solidityKeccak256(['bytes'], [metadata]);

        const mainnetExitRoot = await PolygonZkEVMGlobalExitRoot.lastMainnetExitRoot();

        // compute root merkle tree in Js
        const height = 32;
        const merkleTree = new MerkleTreeBridge(height);
        const leafValue = getLeafValue(
            LEAF_TYPE_MESSAGE,
            originNetwork,
            tokenAddress,
            destinationNetwork,
            destinationAddress,
            amount,
            metadataHash,
        );
        merkleTree.add(leafValue);

        // check merkle root with SC
        const rootJSRollup = merkleTree.getRoot();

        // add rollup Merkle root
        await expect(PolygonZkEVMGlobalExitRoot.connect(rollup).updateExitRoot(rootJSRollup))
            .to.emit(PolygonZkEVMGlobalExitRoot, 'UpdateGlobalExitRoot')
            .withArgs(mainnetExitRoot, rootJSRollup);

        // check roots
        const rollupExitRootSC = await PolygonZkEVMGlobalExitRoot.lastRollupExitRoot();
        expect(rollupExitRootSC).to.be.equal(rootJSRollup);

        const computedGlobalExitRoot = calculateGlobalExitRoot(mainnetExitRoot, rollupExitRootSC);
        expect(computedGlobalExitRoot).to.be.equal(await PolygonZkEVMGlobalExitRoot.getLastGlobalExitRoot());

        // check merkle proof
        const proof = merkleTree.getProofTreeByIndex(0);
        const index = 0;

        // verify merkle proof
        expect(verifyMerkleProof(leafValue, proof, index, rootJSRollup)).to.be.equal(true);
        expect(await PolygonZkEVMBridgeContract.verifyMerkleProof(
            leafValue,
            proof,
            index,
            rootJSRollup,
        )).to.be.equal(true);

        /*
         * claim
         * Can't claim a message as an assets
         */
        await expect(PolygonZkEVMBridgeContract.claimAsset(
            proof,
            index,
            mainnetExitRoot,
            rollupExitRootSC,
            originNetwork,
            tokenAddress,
            destinationNetwork,
            destinationAddress,
            amount,
            metadata,
        )).to.be.revertedWith('InvalidSmtProof');

        /*
         * claim
         * Can't claim without ether
         */
        await expect(PolygonZkEVMBridgeContract.claimMessage(
            proof,
            index,
            mainnetExitRoot,
            rollupExitRootSC,
            originNetwork,
            tokenAddress,
            destinationNetwork,
            destinationAddress,
            amount,
            metadata,
        )).to.be.revertedWith('MessageFailed');

        const balanceDeployer = await ethers.provider.getBalance(deployer.address);
        /*
         * Create a deposit to add ether to the PolygonZkEVMBridge
         * Check deposit amount ether asserts
         */
        await expect(PolygonZkEVMBridgeContract.bridgeAsset(
            networkIDRollup,
            destinationAddress,
            amount,
            tokenAddress,
            true,
            '0x',
            { value: ethers.utils.parseEther('100') },
        )).to.be.revertedWith('AmountDoesNotMatchMsgValue');

        // Check mainnet destination assert
        await expect(PolygonZkEVMBridgeContract.bridgeAsset(
            networkIDMainnet,
            destinationAddress,
            amount,
            tokenAddress,
            true,
            '0x',
            { value: amount },
        )).to.be.revertedWith('DestinationNetworkInvalid');

        // This is used just to pay ether to the PolygonZkEVMBridge smart contract and be able to claim it afterwards.
        expect(await PolygonZkEVMBridgeContract.bridgeAsset(
            networkIDRollup,
            destinationAddress,
            amount,
            tokenAddress,
            true,
            '0x',
            { value: amount },
        ));

        // Check balances before claim
        expect(await ethers.provider.getBalance(PolygonZkEVMBridgeContract.address)).to.be.equal(amount);
        expect(await ethers.provider.getBalance(deployer.address)).to.be.lte(balanceDeployer.sub(amount));

        // Check mainnet destination assert
        await expect(PolygonZkEVMBridgeContract.claimAsset(
            proof,
            index,
            mainnetExitRoot,
            rollupExitRootSC,
            originNetwork,
            tokenAddress,
            destinationNetwork,
            destinationAddress,
            amount,
            metadata,
        )).to.be.revertedWith('InvalidSmtProof');

        await expect(PolygonZkEVMBridgeContract.claimMessage(
            proof,
            index,
            mainnetExitRoot,
            rollupExitRootSC,
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
            );

        // Check balances after claim
        expect(await ethers.provider.getBalance(PolygonZkEVMBridgeContract.address)).to.be.equal(ethers.utils.parseEther('0'));
        expect(await ethers.provider.getBalance(deployer.address)).to.be.lte(balanceDeployer);

        // Can't claim because nullifier
        await expect(PolygonZkEVMBridgeContract.claimAsset(
            proof,
            index,
            mainnetExitRoot,
            rollupExitRootSC,
            originNetwork,
            tokenAddress,
            destinationNetwork,
            destinationAddress,
            amount,
            metadata,
        )).to.be.revertedWith('AlreadyClaimed');
    });
});
