/* eslint-disable no-plusplus, no-await-in-loop */
const { expect } = require('chai');
const { ethers, upgrades } = require('hardhat');

const { contractUtils } = require('@0xpolygonhermez/zkevm-commonjs');

const { calculateAccInputHash, calculateBatchHashData } = contractUtils;

describe('Polygon Data Committee', () => {
    let deployer;
    let trustedAggregator;
    let trustedSequencer;
    let admin;

    let verifierContract;
    let PolygonZkEVMBridgeContract;
    let supernets2Contract;
    let supernets2DataCommitteeContract;
    let maticTokenContract;
    let PolygonZkEVMGlobalExitRoot;

    const maticTokenName = 'Matic Token';
    const maticTokenSymbol = 'MATIC';
    const maticTokenInitialBalance = ethers.utils.parseEther('20000000');

    const genesisRoot = '0x0000000000000000000000000000000000000000000000000000000000000001';

    const networkIDMainnet = 0;
    const urlSequencer = 'http://supernets2-json-rpc:8123';
    const chainID = 1000;
    const networkName = 'supernets2';
    const version = '0.0.1';
    const forkID = 0;
    const pendingStateTimeoutDefault = 100;
    const trustedAggregatorTimeoutDefault = 10;

    // Committe parameters
    const requiredAmountOfSignatures = 3;
    const nMembers = 4;
    let addrs = [];
    let committeeMembers;

    function membersToURLsAndAddrsBytes(members) {
        const urls = [];
        let addrsBytes = '0x';
        for (let i = 0; i < members.length; i++) {
            urls.push(members[i].url);
            addrsBytes += members[i].addr.slice(2);
        }
        return { urls, addrsBytes };
    }

    function addreessToDerivationPath(address) {
        const wallets = addrs.slice(0, nMembers);
        for (let i = 0; i < nMembers; i++) {
            if (wallets[i].address === address) {
                return i;
            }
        }
        throw Error('address not found');
    }

    function getSignatures(hashToSign) {
        let signatures = '0x';
        for (let i = 0; i < requiredAmountOfSignatures; i++) {
            const derivationPath = addreessToDerivationPath(committeeMembers[i].addr);
            const wallet = ethers.Wallet.fromMnemonic(
                // eslint-disable-next-line no-undef
                config.networks.hardhat.accounts.mnemonic,
                // eslint-disable-next-line no-undef
                `${config.networks.hardhat.accounts.path}/${derivationPath}`,
            );
            const signatureRsv = wallet._signingKey().signDigest(hashToSign);
            const signature = ethers.utils.joinSignature(signatureRsv);
            signatures += signature.slice(2);
        }
        return signatures;
    }

    function genSignaturesAndAddrs(hashToSign) {
        const signatures = getSignatures(hashToSign);
        let encodedAssresses = '';
        for (let i = 0; i < nMembers; i++) {
            encodedAssresses += committeeMembers[i].addr.slice(2);
        }
        return signatures + encodedAssresses;
    }

    async function calculateLastAccInputHash(sequences) {
        const lastBatchSequenced = await supernets2Contract.lastBatchSequenced();
        let currentAccInputHash = (await supernets2Contract.sequencedBatches(lastBatchSequenced)).accInputHash;
        for (let i = 0; i < sequences.length; i++) {
            currentAccInputHash = calculateAccInputHash(
                currentAccInputHash,
                sequences[i].transactionsHash,
                sequences[i].globalExitRoot,
                sequences[i].timestamp,
                deployer.address,
            );
        }
        return currentAccInputHash;
    }

    beforeEach('Deploy contract', async () => {
        upgrades.silenceWarnings();

        // load signers
        [deployer, trustedAggregator, trustedSequencer, admin] = await ethers.getSigners();
        committeeMembers = [];
        addrs = await ethers.getSigners();
        const committeeAddrs = addrs.slice(0, nMembers)
            .sort((a, b) => a.address - b.address);
        for (let i = 0; i < nMembers; i++) {
            committeeMembers.push({
                url: `foo-${i}`,
                addr: committeeAddrs[i].address,
            });
        }

        // deploy mock verifier
        const VerifierRollupHelperFactory = await ethers.getContractFactory(
            'VerifierRollupHelperMock',
        );
        verifierContract = await VerifierRollupHelperFactory.deploy();

        // deploy MATIC
        const maticTokenFactory = await ethers.getContractFactory('ERC20PermitMock');
        maticTokenContract = await maticTokenFactory.deploy(
            maticTokenName,
            maticTokenSymbol,
            deployer.address,
            maticTokenInitialBalance,
        );
        await maticTokenContract.deployed();

        // deploy Supernets2DataCommittee
        const supernets2DataCommitteeFactory = await ethers.getContractFactory('Supernets2DataCommittee');
        supernets2DataCommitteeContract = await upgrades.deployProxy(
            supernets2DataCommitteeFactory,
            [],
            { initializer: false },
        );

        const nonceProxyBridge = Number((await ethers.provider.getTransactionCount(deployer.address))) + 2;
        // Always have to redeploy impl since the PolygonZkEVMGlobalExitRoot address changes
        const nonceProxySupernets2 = nonceProxyBridge + 2;

        const precalculateBridgeAddress = ethers.utils.getContractAddress({ from: deployer.address, nonce: nonceProxyBridge });
        const precalculateSupernets2Address = ethers.utils.getContractAddress({ from: deployer.address, nonce: nonceProxySupernets2 });

        const PolygonZkEVMGlobalExitRootFactory = await ethers.getContractFactory('PolygonZkEVMGlobalExitRoot');
        PolygonZkEVMGlobalExitRoot = await upgrades.deployProxy(PolygonZkEVMGlobalExitRootFactory, [], {
            initializer: false,
            constructorArgs: [precalculateSupernets2Address, precalculateBridgeAddress],
            unsafeAllow: ['constructor', 'state-variable-immutable'],
        });

        // deploy PolygonZkEVMBridge
        const PolygonZkEVMBridgeFactory = await ethers.getContractFactory('PolygonZkEVMBridge');
        PolygonZkEVMBridgeContract = await upgrades.deployProxy(PolygonZkEVMBridgeFactory, [], { initializer: false });

        // deploy Supernets2Mock
        const Supernets2Factory = await ethers.getContractFactory('Supernets2Mock');
        supernets2Contract = await upgrades.deployProxy(Supernets2Factory, [], {
            initializer: false,
            constructorArgs: [
                PolygonZkEVMGlobalExitRoot.address,
                maticTokenContract.address,
                verifierContract.address,
                PolygonZkEVMBridgeContract.address,
                supernets2DataCommitteeContract.address,
                chainID,
                forkID,
            ],
            unsafeAllow: ['constructor', 'state-variable-immutable'],
        });

        expect(precalculateBridgeAddress).to.be.equal(PolygonZkEVMBridgeContract.address);
        expect(precalculateSupernets2Address).to.be.equal(supernets2Contract.address);

        await PolygonZkEVMBridgeContract.initialize(networkIDMainnet, PolygonZkEVMGlobalExitRoot.address, supernets2Contract.address);
        await supernets2Contract.initialize(
            {
                admin: admin.address,
                trustedSequencer: trustedSequencer.address,
                pendingStateTimeout: pendingStateTimeoutDefault,
                trustedAggregator: trustedAggregator.address,
                trustedAggregatorTimeout: trustedAggregatorTimeoutDefault,
            },
            genesisRoot,
            urlSequencer,
            networkName,
            version,
        );

        // fund sequencer address with Matic tokens
        await maticTokenContract.transfer(trustedSequencer.address, ethers.utils.parseEther('1000'));
        // setup committee
        const { urls, addrsBytes } = membersToURLsAndAddrsBytes(committeeMembers);
        const expectedHash = ethers.utils.solidityKeccak256(['bytes'], [addrsBytes]);
        await supernets2DataCommitteeContract.initialize();
        await expect(supernets2DataCommitteeContract.connect(deployer)
            .setupCommittee(requiredAmountOfSignatures, urls, addrsBytes))
            .to.emit(supernets2DataCommitteeContract, 'CommitteeUpdated')
            .withArgs(expectedHash);
        const actualAmountOfmembers = await supernets2DataCommitteeContract.getAmountOfMembers();
        expect(actualAmountOfmembers).to.be.equal(committeeMembers.length);
    });

    // SETUP COMMITTEE tests
    it('fail because required amount of signatures is greater than members', async () => {
        const { urls, addrsBytes } = membersToURLsAndAddrsBytes(committeeMembers);
        await expect(supernets2DataCommitteeContract.connect(deployer)
            .setupCommittee(nMembers + 1, urls, addrsBytes))
            .to.be.revertedWith('TooManyRequiredSignatures');
    });

    it('fail because wrong address order', async () => {
        const wrongAddressOrderMembers = [{
            url: 'foo',
            addr: '0x341f33e89ec1f28b9d5618413c223f973426140b',
        }, {
            url: 'bar',
            addr: '0x2d630a3ac2b39472958507d73e3e450acde3431c',
        }];
        const { urls, addrsBytes } = membersToURLsAndAddrsBytes(wrongAddressOrderMembers);
        await expect(supernets2DataCommitteeContract.connect(deployer)
            .setupCommittee(1, urls, addrsBytes))
            .to.be.revertedWith('WrongAddrOrder');
    });

    it('fail because repeated address', async () => {
        const wrongAddressOrderMembers = [{
            url: 'foo',
            addr: '0x2d630a3ac2b39472958507d73e3e450acde3431c',
        }, {
            url: 'bar',
            addr: '0x2d630a3ac2b39472958507d73e3e450acde3431c',
        }];
        const { urls, addrsBytes } = membersToURLsAndAddrsBytes(wrongAddressOrderMembers);
        await expect(supernets2DataCommitteeContract.connect(deployer)
            .setupCommittee(1, urls, addrsBytes))
            .to.be.revertedWith('WrongAddrOrder');
    });

    it('fail because zero address', async () => {
        const wrongAddressOrderMembers = [{
            url: 'foo',
            addr: '0x0000000000000000000000000000000000000000',
        }, {
            url: 'bar',
            addr: '0x2d630a3ac2b39472958507d73e3e450acde3431c',
        }];
        const { urls, addrsBytes } = membersToURLsAndAddrsBytes(wrongAddressOrderMembers);
        await expect(supernets2DataCommitteeContract.connect(deployer)
            .setupCommittee(1, urls, addrsBytes))
            .to.be.revertedWith('WrongAddrOrder');
    });

    it('fail because empty URL', async () => {
        const wrongAddressOrderMembers = [{
            url: 'foo',
            addr: '0x2d630a3ac2b39472958507d73e3e450acde3431c',
        }, {
            url: '',
            addr: '0x341f33e89ec1f28b9d5618413c223f973426140b',
        }];
        const { urls, addrsBytes } = membersToURLsAndAddrsBytes(wrongAddressOrderMembers);
        await expect(supernets2DataCommitteeContract.connect(deployer)
            .setupCommittee(1, urls, addrsBytes))
            .to.be.revertedWith('EmptyURLNotAllowed');
    });

    it('fail because unexpected addrsBytes length', async () => {
        const wrongAddressOrderMembers = [{
            url: 'foo',
            addr: '0x2d630a3ac2b39472958507d73e3e450acde3431c',
        }, {
            url: 'bar',
            addr: '0x341f33e89ec1f28b9d5618413c223f973426140b',
        }];
        const { urls, addrsBytes } = membersToURLsAndAddrsBytes(wrongAddressOrderMembers);
        await expect(supernets2DataCommitteeContract.connect(deployer)
            .setupCommittee(1, urls, addrsBytes.substring(0, addrsBytes.length - 2)))
            .to.be.revertedWith('UnexpectedAddrsBytesLength');
        await expect(supernets2DataCommitteeContract.connect(deployer)
            .setupCommittee(1, urls, `${addrsBytes}ff`))
            .to.be.revertedWith('UnexpectedAddrsBytesLength');
    });

    // VERIFY SIGNATURES tests
    it('fails because signature and addrs byte array has wrong size', async () => {
        const l2txData = '0x123456';
        const transactionsHash = calculateBatchHashData(l2txData);
        const currentTimestamp = (await ethers.provider.getBlock()).timestamp;
        const sequence = {
            transactionsHash,
            globalExitRoot: ethers.constants.HashZero,
            timestamp: ethers.BigNumber.from(currentTimestamp),
            minForcedTimestamp: 0,
        };

        // Sign committee data
        const hashToSign = await calculateLastAccInputHash([sequence]);
        const signaturesAndAddrs = genSignaturesAndAddrs(hashToSign);

        // Remove last byte
        const withMissingByte = signaturesAndAddrs.substring(0, signaturesAndAddrs.length - 2);
        await expect(supernets2Contract.connect(trustedSequencer)
            .sequenceBatches([sequence], deployer.address, withMissingByte))
            .to.be.revertedWith('UnexpectedAddrsAndSignaturesSize');

        // Add extra byte
        const withExtraByte = `${signaturesAndAddrs.substring(0, signaturesAndAddrs.length)}11`;
        await expect(supernets2Contract.connect(trustedSequencer)
            .sequenceBatches([sequence], deployer.address, withExtraByte))
            .to.be.revertedWith('UnexpectedAddrsAndSignaturesSize');

        // Add extra bytes that matches with address length (20 bytes) will fail to match the hash
        const extra20Bytes = '690b9a9e9aa1c9db991c7721a92d351db4fac990';
        await expect(supernets2Contract.connect(trustedSequencer)
            .sequenceBatches([sequence], deployer.address, signaturesAndAddrs + extra20Bytes))
            .to.be.revertedWith('UnexpectedCommitteeHash');
    });

    it('fails because the hash of the addresses doesnt match', async () => {
        const l2txData = '0x123456';
        const transactionsHash = calculateBatchHashData(l2txData);
        const currentTimestamp = (await ethers.provider.getBlock()).timestamp;
        const sequence = {
            transactionsHash,
            globalExitRoot: ethers.constants.HashZero,
            timestamp: ethers.BigNumber.from(currentTimestamp),
            minForcedTimestamp: 0,
        };

        // Sign committee data
        const hashToSign = await calculateLastAccInputHash([sequence]);
        const signaturesAndAddrs = genSignaturesAndAddrs(hashToSign);

        // Change half byte of the address list, so the hash doesn't match
        const withLastHalfByteSwapped = `${signaturesAndAddrs.substring(0, signaturesAndAddrs.length - 1)}a`;
        await expect(supernets2Contract.connect(trustedSequencer)
            .sequenceBatches([sequence], deployer.address, withLastHalfByteSwapped))
            .to.be.revertedWith('UnexpectedCommitteeHash');
    });

    it('fails because there is an address in the list that is not part of the committe', async () => {
        const l2txData = '0x123456';
        const transactionsHash = calculateBatchHashData(l2txData);
        const currentTimestamp = (await ethers.provider.getBlock()).timestamp;
        const sequence = {
            transactionsHash,
            globalExitRoot: ethers.constants.HashZero,
            timestamp: ethers.BigNumber.from(currentTimestamp),
            minForcedTimestamp: 0,
        };

        // Sign committee data
        const hashToSign = await calculateLastAccInputHash([sequence]);
        const signaturesAndAddrs = genSignaturesAndAddrs(hashToSign);

        // Replace last address
        const addressNotFromTheCommittee = '690b9a9e9aa1c9db991c7721a92d351db4fac990';
        const withWrongAddr = signaturesAndAddrs.substring(0, signaturesAndAddrs.length - 40)
            + addressNotFromTheCommittee;
        await expect(supernets2Contract.connect(trustedSequencer)
            .sequenceBatches([sequence], deployer.address, withWrongAddr))
            .to.be.revertedWith('UnexpectedCommitteeHash');
    });

    it('fails because there is a repeated address in the list', async () => {
        const l2txData = '0x123456';
        const transactionsHash = calculateBatchHashData(l2txData);
        const currentTimestamp = (await ethers.provider.getBlock()).timestamp;
        const sequence = {
            transactionsHash,
            globalExitRoot: ethers.constants.HashZero,
            timestamp: ethers.BigNumber.from(currentTimestamp),
            minForcedTimestamp: 0,
        };

        // Sign committee data
        const hashToSign = await calculateLastAccInputHash([sequence]);
        const signaturesAndAddrs = genSignaturesAndAddrs(hashToSign);

        // Replace last address
        const repeatedAddr = signaturesAndAddrs.substring(
            signaturesAndAddrs.length - 40,
            signaturesAndAddrs.length,
        );
        const withWrongAddr = signaturesAndAddrs.substring(0, signaturesAndAddrs.length - 80)
            + repeatedAddr + repeatedAddr;
        await expect(supernets2Contract.connect(trustedSequencer)
            .sequenceBatches([sequence], deployer.address, withWrongAddr))
            .to.be.revertedWith('UnexpectedCommitteeHash');
    });

    it('fails because there is a signing address that is not part of the committe', async () => {
        const l2txData = '0x123456';
        const transactionsHash = calculateBatchHashData(l2txData);
        const currentTimestamp = (await ethers.provider.getBlock()).timestamp;
        const sequence = {
            transactionsHash,
            globalExitRoot: ethers.constants.HashZero,
            timestamp: ethers.BigNumber.from(currentTimestamp),
            minForcedTimestamp: 0,
        };

        // Sign committee data
        const hashToSign = await calculateLastAccInputHash([sequence]);
        const signaturesAndAddrs = genSignaturesAndAddrs(hashToSign);

        // Replace last address
        const withWrongSignature = `0xF${signaturesAndAddrs.slice(3)}`;
        await expect(supernets2Contract.connect(trustedSequencer)
            .sequenceBatches([sequence], deployer.address, withWrongSignature))
            .to.be.revertedWith('CommitteeAddressDoesntExist');
    });

    it('fails because there is a repeated signature', async () => {
        const l2txData = '0x123456';
        const transactionsHash = calculateBatchHashData(l2txData);
        const currentTimestamp = (await ethers.provider.getBlock()).timestamp;
        const sequence = {
            transactionsHash,
            globalExitRoot: ethers.constants.HashZero,
            timestamp: ethers.BigNumber.from(currentTimestamp),
            minForcedTimestamp: 0,
        };

        // Sign committee data
        const hashToSign = await calculateLastAccInputHash([sequence]);
        const signaturesAndAddrs = genSignaturesAndAddrs(hashToSign);

        // Replace last address
        const signatureSize = 65 * 2;
        const zeroXSize = 2;
        const repeatedSignature = signaturesAndAddrs.substring(zeroXSize, zeroXSize + signatureSize);
        const withoutZeroXAndTwoFirstSignatures = signaturesAndAddrs.substring(zeroXSize + 2 * signatureSize, signaturesAndAddrs.length);
        const withRepeatedSignature = `0x${repeatedSignature}${repeatedSignature
        }${withoutZeroXAndTwoFirstSignatures}`;

        await expect(supernets2Contract.connect(trustedSequencer)
            .sequenceBatches([sequence], deployer.address, withRepeatedSignature))
            .to.be.revertedWith('CommitteeAddressDoesntExist');
    });

    it('success single batch', async () => {
        const l2txData = '0x123456';
        const transactionsHash = calculateBatchHashData(l2txData);
        const maticAmount = await supernets2Contract.batchFee();
        const currentTimestamp = (await ethers.provider.getBlock()).timestamp;

        const sequence = {
            transactionsHash,
            globalExitRoot: ethers.constants.HashZero,
            timestamp: ethers.BigNumber.from(currentTimestamp),
            minForcedTimestamp: 0,
        };

        // Approve tokens
        await expect(
            maticTokenContract.connect(trustedSequencer).approve(supernets2Contract.address, maticAmount),
        ).to.emit(maticTokenContract, 'Approval');

        // Sign committee data
        const hashToSign = await calculateLastAccInputHash([sequence]);
        const signaturesAndAddrs = genSignaturesAndAddrs(hashToSign);

        // Send sequence successfully
        const lastBatchSequenced = await supernets2Contract.lastBatchSequenced();
        await expect(supernets2Contract.connect(trustedSequencer)
            .sequenceBatches([sequence], deployer.address, signaturesAndAddrs))
            .to.emit(supernets2Contract, 'SequenceBatches')
            .withArgs(lastBatchSequenced + 1);
    });

    it('success multiple batches', async () => {
        const l2txData1 = '0x123456';
        const transactionsHash1 = calculateBatchHashData(l2txData1);
        const timestamp1 = (await ethers.provider.getBlock()).timestamp;
        const sequence1 = {
            transactionsHash: transactionsHash1,
            globalExitRoot: ethers.constants.HashZero,
            timestamp: ethers.BigNumber.from(timestamp1),
            minForcedTimestamp: 0,
        };

        const l2txData2 = '0x042069';
        const transactionsHash2 = calculateBatchHashData(l2txData2);
        const timestamp2 = (await ethers.provider.getBlock()).timestamp;
        const sequence2 = {
            transactionsHash: transactionsHash2,
            globalExitRoot: ethers.constants.HashZero,
            timestamp: ethers.BigNumber.from(timestamp2),
            minForcedTimestamp: 0,
        };

        // Approve tokens
        const maticAmount = (await supernets2Contract.batchFee()).mul(2);
        await expect(
            maticTokenContract.connect(trustedSequencer).approve(supernets2Contract.address, maticAmount),
        ).to.emit(maticTokenContract, 'Approval');

        // Sign committee data
        const hashToSign = await calculateLastAccInputHash([sequence1, sequence2]);
        const signaturesAndAddrs = genSignaturesAndAddrs(hashToSign);

        // Send sequence successfully
        const lastBatchSequenced = await supernets2Contract.lastBatchSequenced();
        await expect(supernets2Contract.connect(trustedSequencer)
            .sequenceBatches([sequence1, sequence2], deployer.address, signaturesAndAddrs))
            .to.emit(supernets2Contract, 'SequenceBatches')
            .withArgs(lastBatchSequenced + 2);
    });

    it('success forced batch', async () => {
        const l2txDataForceBatch = '0x123456';
        const transactionsHashForceBatch = calculateBatchHashData(l2txDataForceBatch);
        const maticAmount = await supernets2Contract.getForcedBatchFee();
        const lastGlobalExitRoot = await PolygonZkEVMGlobalExitRoot.getLastGlobalExitRoot();

        await expect(
            maticTokenContract.approve(supernets2Contract.address, maticAmount),
        ).to.emit(maticTokenContract, 'Approval');

        const lastForcedBatch = (await supernets2Contract.lastForceBatch()) + 1;

        // Activate forced batches
        await expect(
            supernets2Contract.connect(admin).activateForceBatches(),
        ).to.emit(supernets2Contract, 'ActivateForceBatches');

        // Force batch
        await expect(supernets2Contract.forceBatch(l2txDataForceBatch, maticAmount))
            .to.emit(supernets2Contract, 'ForceBatch')
            .withArgs(lastForcedBatch, lastGlobalExitRoot, deployer.address, '0x');

        // sequence 2 batches
        const l2txData = '0x1234';
        const transactionsHash2 = calculateBatchHashData(l2txData);
        const maticAmountSequence = (await supernets2Contract.batchFee()).mul(1);

        const currentTimestamp = (await ethers.provider.getBlock()).timestamp;

        const sequence1 = {
            transactionsHash: transactionsHashForceBatch,
            globalExitRoot: lastGlobalExitRoot,
            timestamp: currentTimestamp,
            minForcedTimestamp: currentTimestamp,
        };

        const sequence2 = {
            transactionsHash: transactionsHash2,
            globalExitRoot: ethers.constants.HashZero,
            timestamp: currentTimestamp,
            minForcedTimestamp: 0,
        };

        const initialOwnerBalance = await maticTokenContract.balanceOf(
            await trustedSequencer.address,
        );

        // Approve tokens
        await expect(
            maticTokenContract.connect(trustedSequencer).approve(supernets2Contract.address, maticAmountSequence),
        ).to.emit(maticTokenContract, 'Approval');

        const lastBatchSequenced = await supernets2Contract.lastBatchSequenced();

        // Assert that the timestamp requirements must accomplish with force batches too

        sequence1.minForcedTimestamp += 1;
        await expect(supernets2Contract.connect(trustedSequencer).sequenceBatches([sequence1, sequence2], trustedSequencer.address, []))
            .to.be.revertedWith('ForcedDataDoesNotMatch');
        sequence1.minForcedTimestamp -= 1;

        sequence1.timestamp -= 1;
        await expect(supernets2Contract.connect(trustedSequencer).sequenceBatches([sequence1, sequence2], trustedSequencer.address, []))
            .to.be.revertedWith('SequencedTimestampBelowForcedTimestamp');
        sequence1.timestamp += 1;

        sequence1.timestamp = currentTimestamp + 10;
        await expect(supernets2Contract.connect(trustedSequencer).sequenceBatches([sequence1, sequence2], trustedSequencer.address, []))
            .to.be.revertedWith('SequencedTimestampInvalid');
        sequence1.timestamp = currentTimestamp;

        sequence2.timestamp -= 1;
        await expect(supernets2Contract.connect(trustedSequencer).sequenceBatches([sequence1, sequence2], trustedSequencer.address, []))
            .to.be.revertedWith('SequencedTimestampInvalid');
        sequence2.timestamp += 1;

        // Sequence Bathces

        let batchAccInputHashJs = calculateAccInputHash(
            ethers.constants.HashZero,
            sequence1.transactionsHash,
            sequence1.globalExitRoot,
            sequence1.timestamp,
            trustedSequencer.address,
        );

        // Calcultate input Hahs for batch 2
        batchAccInputHashJs = calculateAccInputHash(
            batchAccInputHashJs,
            sequence2.transactionsHash,
            sequence2.globalExitRoot,
            sequence2.timestamp,
            trustedSequencer.address,
        );
        const signaturesAndAddrs = genSignaturesAndAddrs(batchAccInputHashJs);
        await expect(supernets2Contract.connect(trustedSequencer)
            .sequenceBatches([sequence1, sequence2], trustedSequencer.address, signaturesAndAddrs))
            .to.emit(supernets2Contract, 'SequenceBatches')
            .withArgs(Number(lastBatchSequenced) + 2);

        const sequencedTimestamp = (await ethers.provider.getBlock()).timestamp;

        const finalOwnerBalance = await maticTokenContract.balanceOf(
            await trustedSequencer.address,
        );

        expect(finalOwnerBalance).to.equal(
            ethers.BigNumber.from(initialOwnerBalance).sub(ethers.BigNumber.from(maticAmountSequence)),
        );

        // Check batch mapping
        const batchAccInputHash = (await supernets2Contract.sequencedBatches(1)).accInputHash;
        // Only last batch is added to the mapping
        expect(batchAccInputHash).to.be.equal(ethers.constants.HashZero);

        const batchData2 = await supernets2Contract.sequencedBatches(2);
        expect(batchData2.accInputHash).to.be.equal(batchAccInputHashJs);
        expect(batchData2.sequencedTimestamp).to.be.equal(sequencedTimestamp);
        expect(batchData2.previousLastBatchSequenced).to.be.equal(0);
    });
});
