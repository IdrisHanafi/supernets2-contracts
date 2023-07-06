// SPDX-License-Identifier: AGPL-3.0

pragma solidity 0.8.17;

interface ISupernets2dot0DataCommittee {
    function verifySignatures(bytes32 hash, bytes memory signaturesAndAddrs) external view;
}