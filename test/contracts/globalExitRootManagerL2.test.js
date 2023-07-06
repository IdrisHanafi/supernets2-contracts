const { expect } = require('chai');
const { ethers } = require('hardhat');

const zero32bytes = '0x0000000000000000000000000000000000000000000000000000000000000000';

describe('Global Exit Root L2', () => {
    let Supernets2Bridge;
    let supernets2GlobalExitRoot;
    let deployer;

    beforeEach('Deploy contracts', async () => {
        // load signers
        [deployer, Supernets2Bridge] = await ethers.getSigners();

        // deploy global exit root manager
        const Supernets2GlobalExitRootFactory = await ethers.getContractFactory('Supernets2GlobalExitRootL2Mock', deployer);
        supernets2GlobalExitRoot = await Supernets2GlobalExitRootFactory.deploy(Supernets2Bridge.address);
    });

    it('should check the constructor parameters', async () => {
        expect(await supernets2GlobalExitRoot.bridgeAddress()).to.be.equal(Supernets2Bridge.address);
        expect(await supernets2GlobalExitRoot.lastRollupExitRoot()).to.be.equal(zero32bytes);
    });

    it('should update root and check global exit root', async () => {
        const newRootRollup = ethers.utils.hexlify(ethers.utils.randomBytes(32));

        await expect(supernets2GlobalExitRoot.updateExitRoot(newRootRollup))
            .to.be.revertedWith('OnlyAllowedContracts');

        // Update root from the rollup
        await supernets2GlobalExitRoot.connect(Supernets2Bridge).updateExitRoot(newRootRollup);

        expect(await supernets2GlobalExitRoot.lastRollupExitRoot()).to.be.equal(newRootRollup);
    });

    it('should update root and check the storage position matches', async () => {
        // Check global exit root
        const newRoot = ethers.utils.hexlify(ethers.utils.randomBytes(32));
        const blockNumber = 1;
        await supernets2GlobalExitRoot.setLastGlobalExitRoot(newRoot, blockNumber);
        expect(await supernets2GlobalExitRoot.globalExitRootMap(newRoot)).to.be.equal(blockNumber);
        const mapStoragePosition = 0;
        const key = newRoot;
        const storagePosition = ethers.utils.solidityKeccak256(['uint256', 'uint256'], [key, mapStoragePosition]);
        const storageValue = await ethers.provider.getStorageAt(supernets2GlobalExitRoot.address, storagePosition);
        expect(blockNumber).to.be.equal(ethers.BigNumber.from(storageValue).toNumber());

        // Check rollup exit root
        const newRootRollupExitRoot = ethers.utils.hexlify(ethers.utils.randomBytes(32));
        await supernets2GlobalExitRoot.setExitRoot(newRootRollupExitRoot);
        expect(await supernets2GlobalExitRoot.lastRollupExitRoot()).to.be.equal(newRootRollupExitRoot);

        const storagePositionExitRoot = 1;
        const storageValueExitRoot = await ethers.provider.getStorageAt(supernets2GlobalExitRoot.address, storagePositionExitRoot);
        expect(newRootRollupExitRoot, storageValueExitRoot);
    });
});
