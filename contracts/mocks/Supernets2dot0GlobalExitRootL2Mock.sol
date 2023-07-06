// SPDX-License-Identifier: AGPL-3.0
pragma solidity 0.8.17;

import "../Supernets2dot0GlobalExitRootL2.sol";

/**
 * Contract responsible for managing the exit roots across multiple networks

 */
contract Supernets2dot0GlobalExitRootL2Mock is Supernets2dot0GlobalExitRootL2 {
    /**
     * @param _bridgeAddress Supernets2dot0 Bridge contract address
     */
    constructor(
        address _bridgeAddress
    ) Supernets2dot0GlobalExitRootL2(_bridgeAddress) {}

    /**
     * @notice Set globalExitRoot
     * @param globalExitRoot New global exit root
     * @param blockNumber block number
     */
    function setLastGlobalExitRoot(
        bytes32 globalExitRoot,
        uint256 blockNumber
    ) public {
        globalExitRootMap[globalExitRoot] = blockNumber;
    }

    /**
     * @notice Set rollup exit root
     * @param newRoot New rollup exit root
     */
    function setExitRoot(bytes32 newRoot) public {
        lastRollupExitRoot = newRoot;
    }
}
