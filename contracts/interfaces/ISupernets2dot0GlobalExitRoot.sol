// SPDX-License-Identifier: AGPL-3.0

pragma solidity 0.8.17;
import "./IBaseSupernets2dot0GlobalExitRoot.sol";

interface ISupernets2dot0GlobalExitRoot is IBaseSupernets2dot0GlobalExitRoot {
    function getLastGlobalExitRoot() external view returns (bytes32);
}
