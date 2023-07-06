// SPDX-License-Identifier: AGPL-3.0
pragma solidity 0.8.17;

import "../Supernets2dot0GlobalExitRoot.sol";

/**
 * Contract responsible for managing the exit roots across multiple networks

 */
contract Supernets2dot0GlobalExitRootMock is Supernets2dot0GlobalExitRoot {
    /**
     * @param _rollupAddress Rollup contract address
     * @param _bridgeAddress Supernets2dot0 Bridge contract address
     */
    constructor(
        address _rollupAddress,
        address _bridgeAddress
    ) Supernets2dot0GlobalExitRoot(_rollupAddress, _bridgeAddress) {}

    /**
     * @notice Set last global exit root
     * @param timestamp timestamp
     */
    function setLastGlobalExitRoot(uint256 timestamp) public {
        globalExitRootMap[getLastGlobalExitRoot()] = timestamp;
    }

    /**
     * @notice Set last global exit root
     * @param timestamp timestamp
     */
    function setGlobalExitRoot(
        bytes32 globalExitRoot,
        uint256 timestamp
    ) public {
        globalExitRootMap[globalExitRoot] = timestamp;
    }
}
