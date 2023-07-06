// SPDX-License-Identifier: AGPL-3.0

pragma solidity 0.8.17;
import "./IBaseSupernets2GlobalExitRoot.sol";

interface ISupernets2GlobalExitRoot is IBaseSupernets2GlobalExitRoot {
    function getLastGlobalExitRoot() external view returns (bytes32);
}
