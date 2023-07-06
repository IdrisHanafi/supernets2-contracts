const { expect } = require('chai');
const { ethers } = require('hardhat');

function calculateGlobalExitRoot(mainnetExitRoot, rollupExitRoot) {
    return ethers.utils.solidityKeccak256(['bytes32', 'bytes32'], [mainnetExitRoot, rollupExitRoot]);
}
const zero32bytes = '0x0000000000000000000000000000000000000000000000000000000000000000';

describe('Global Exit Root', () => {
    let rollup;
    let Supernets2Bridge;

    let supernets2GlobalExitRoot;
    beforeEach('Deploy contracts', async () => {
        // load signers
        [, rollup, Supernets2Bridge] = await ethers.getSigners();

        // deploy global exit root manager
        const Supernets2GlobalExitRootFactory = await ethers.getContractFactory('Supernets2GlobalExitRoot');

        supernets2GlobalExitRoot = await Supernets2GlobalExitRootFactory.deploy(
            rollup.address,
            Supernets2Bridge.address,
        );
        await supernets2GlobalExitRoot.deployed();
    });

    it('should check the constructor parameters', async () => {
        expect(await supernets2GlobalExitRoot.rollupAddress()).to.be.equal(rollup.address);
        expect(await supernets2GlobalExitRoot.bridgeAddress()).to.be.equal(Supernets2Bridge.address);
        expect(await supernets2GlobalExitRoot.lastRollupExitRoot()).to.be.equal(zero32bytes);
        expect(await supernets2GlobalExitRoot.lastMainnetExitRoot()).to.be.equal(zero32bytes);
    });

    it('should update root and check global exit root', async () => {
        const newRootRollup = ethers.utils.hexlify(ethers.utils.randomBytes(32));

        await expect(supernets2GlobalExitRoot.updateExitRoot(newRootRollup))
            .to.be.revertedWith('OnlyAllowedContracts');

        // Update root from the rollup
        await expect(supernets2GlobalExitRoot.connect(rollup).updateExitRoot(newRootRollup))
            .to.emit(supernets2GlobalExitRoot, 'UpdateGlobalExitRoot')
            .withArgs(zero32bytes, newRootRollup);

        expect(await supernets2GlobalExitRoot.getLastGlobalExitRoot())
            .to.be.equal(calculateGlobalExitRoot(zero32bytes, newRootRollup));

        // Update root from the Supernets2Bridge
        const newRootBridge = ethers.utils.hexlify(ethers.utils.randomBytes(32));
        await expect(supernets2GlobalExitRoot.connect(Supernets2Bridge).updateExitRoot(newRootBridge))
            .to.emit(supernets2GlobalExitRoot, 'UpdateGlobalExitRoot')
            .withArgs(newRootBridge, newRootRollup);

        expect(await supernets2GlobalExitRoot.lastMainnetExitRoot()).to.be.equal(newRootBridge);
        expect(await supernets2GlobalExitRoot.getLastGlobalExitRoot())
            .to.be.equal(calculateGlobalExitRoot(newRootBridge, newRootRollup));
    });
});
