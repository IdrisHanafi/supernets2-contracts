const { expect } = require('chai');
const { ethers } = require('hardhat');

function calculateGlobalExitRoot(mainnetExitRoot, rollupExitRoot) {
    return ethers.utils.solidityKeccak256(['bytes32', 'bytes32'], [mainnetExitRoot, rollupExitRoot]);
}
const zero32bytes = '0x0000000000000000000000000000000000000000000000000000000000000000';

describe('Global Exit Root', () => {
    let rollup;
    let Supernets2dot0Bridge;

    let supernets2dot0GlobalExitRoot;
    beforeEach('Deploy contracts', async () => {
        // load signers
        [, rollup, Supernets2dot0Bridge] = await ethers.getSigners();

        // deploy global exit root manager
        const Supernets2dot0GlobalExitRootFactory = await ethers.getContractFactory('Supernets2dot0GlobalExitRoot');

        supernets2dot0GlobalExitRoot = await Supernets2dot0GlobalExitRootFactory.deploy(
            rollup.address,
            Supernets2dot0Bridge.address,
        );
        await supernets2dot0GlobalExitRoot.deployed();
    });

    it('should check the constructor parameters', async () => {
        expect(await supernets2dot0GlobalExitRoot.rollupAddress()).to.be.equal(rollup.address);
        expect(await supernets2dot0GlobalExitRoot.bridgeAddress()).to.be.equal(Supernets2dot0Bridge.address);
        expect(await supernets2dot0GlobalExitRoot.lastRollupExitRoot()).to.be.equal(zero32bytes);
        expect(await supernets2dot0GlobalExitRoot.lastMainnetExitRoot()).to.be.equal(zero32bytes);
    });

    it('should update root and check global exit root', async () => {
        const newRootRollup = ethers.utils.hexlify(ethers.utils.randomBytes(32));

        await expect(supernets2dot0GlobalExitRoot.updateExitRoot(newRootRollup))
            .to.be.revertedWith('OnlyAllowedContracts');

        // Update root from the rollup
        await expect(supernets2dot0GlobalExitRoot.connect(rollup).updateExitRoot(newRootRollup))
            .to.emit(supernets2dot0GlobalExitRoot, 'UpdateGlobalExitRoot')
            .withArgs(zero32bytes, newRootRollup);

        expect(await supernets2dot0GlobalExitRoot.getLastGlobalExitRoot())
            .to.be.equal(calculateGlobalExitRoot(zero32bytes, newRootRollup));

        // Update root from the Supernets2dot0Bridge
        const newRootBridge = ethers.utils.hexlify(ethers.utils.randomBytes(32));
        await expect(supernets2dot0GlobalExitRoot.connect(Supernets2dot0Bridge).updateExitRoot(newRootBridge))
            .to.emit(supernets2dot0GlobalExitRoot, 'UpdateGlobalExitRoot')
            .withArgs(newRootBridge, newRootRollup);

        expect(await supernets2dot0GlobalExitRoot.lastMainnetExitRoot()).to.be.equal(newRootBridge);
        expect(await supernets2dot0GlobalExitRoot.getLastGlobalExitRoot())
            .to.be.equal(calculateGlobalExitRoot(newRootBridge, newRootRollup));
    });
});
