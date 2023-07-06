const { expect } = require('chai');
const { ethers } = require('hardhat');

const zero32bytes = '0x0000000000000000000000000000000000000000000000000000000000000000';

describe('Global Exit Root L2', () => {
    let Supernets2dot0Bridge;
    let supernets2dot0GlobalExitRoot;
    let deployer;

    beforeEach('Deploy contracts', async () => {
        // load signers
        [deployer, Supernets2dot0Bridge] = await ethers.getSigners();

        // deploy global exit root manager
        const Supernets2dot0GlobalExitRootFactory = await ethers.getContractFactory('Supernets2dot0GlobalExitRootL2Mock', deployer);
        supernets2dot0GlobalExitRoot = await Supernets2dot0GlobalExitRootFactory.deploy(Supernets2dot0Bridge.address);
    });

    it('should check the constructor parameters', async () => {
        expect(await supernets2dot0GlobalExitRoot.bridgeAddress()).to.be.equal(Supernets2dot0Bridge.address);
        expect(await supernets2dot0GlobalExitRoot.lastRollupExitRoot()).to.be.equal(zero32bytes);
    });

    it('should update root and check global exit root', async () => {
        const newRootRollup = ethers.utils.hexlify(ethers.utils.randomBytes(32));

        await expect(supernets2dot0GlobalExitRoot.updateExitRoot(newRootRollup))
            .to.be.revertedWith('OnlyAllowedContracts');

        // Update root from the rollup
        await supernets2dot0GlobalExitRoot.connect(Supernets2dot0Bridge).updateExitRoot(newRootRollup);

        expect(await supernets2dot0GlobalExitRoot.lastRollupExitRoot()).to.be.equal(newRootRollup);
    });

    it('should update root and check the storage position matches', async () => {
        // Check global exit root
        const newRoot = ethers.utils.hexlify(ethers.utils.randomBytes(32));
        const blockNumber = 1;
        await supernets2dot0GlobalExitRoot.setLastGlobalExitRoot(newRoot, blockNumber);
        expect(await supernets2dot0GlobalExitRoot.globalExitRootMap(newRoot)).to.be.equal(blockNumber);
        const mapStoragePosition = 0;
        const key = newRoot;
        const storagePosition = ethers.utils.solidityKeccak256(['uint256', 'uint256'], [key, mapStoragePosition]);
        const storageValue = await ethers.provider.getStorageAt(supernets2dot0GlobalExitRoot.address, storagePosition);
        expect(blockNumber).to.be.equal(ethers.BigNumber.from(storageValue).toNumber());

        // Check rollup exit root
        const newRootRollupExitRoot = ethers.utils.hexlify(ethers.utils.randomBytes(32));
        await supernets2dot0GlobalExitRoot.setExitRoot(newRootRollupExitRoot);
        expect(await supernets2dot0GlobalExitRoot.lastRollupExitRoot()).to.be.equal(newRootRollupExitRoot);

        const storagePositionExitRoot = 1;
        const storageValueExitRoot = await ethers.provider.getStorageAt(supernets2dot0GlobalExitRoot.address, storagePositionExitRoot);
        expect(newRootRollupExitRoot, storageValueExitRoot);
    });
});
