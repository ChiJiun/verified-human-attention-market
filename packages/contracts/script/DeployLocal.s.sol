// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {CampaignManager} from "../src/CampaignManager.sol";
import {MockUSDC} from "../test/CampaignManager.t.sol";

interface LocalScriptVm {
    function envAddress(string calldata name) external view returns (address);
    function startBroadcast() external;
    function stopBroadcast() external;
    function projectRoot() external view returns (string memory);
    function writeFile(string calldata path, string calldata data) external;
    function toString(address value) external pure returns (string memory);
    function toString(uint256 value) external pure returns (string memory);
}

/// @notice Local anvil demo deployment: a mock 6-decimal USDC plus
/// CampaignManager with the POC limits (ADR-0005/0006). Refuses any chain
/// other than anvil (31337).
/// @dev forge script script/DeployLocal.s.sol --rpc-url http://127.0.0.1:8545 \
///        --broadcast --private-key <anvil account 0 key>
/// Env: CLAIM_SIGNER_ADDRESS, ADVERTISER_ADDRESS (receives 100 mock USDC).
contract DeployLocal {
    LocalScriptVm private constant vm = LocalScriptVm(address(uint160(uint256(keccak256("hevm cheat code")))));

    uint256 private constant ONE_USDC = 1_000_000;

    error NotLocalChain(uint256 chainId);

    function run() external {
        if (block.chainid != 31337) revert NotLocalChain(block.chainid);

        address signer = vm.envAddress("CLAIM_SIGNER_ADDRESS");
        address advertiser = vm.envAddress("ADVERTISER_ADDRESS");
        uint256 deployBlock = block.number;

        vm.startBroadcast();
        MockUSDC usdc = new MockUSDC();
        uint128 budgetLimit = uint128(10 * ONE_USDC);
        CampaignManager manager = new CampaignManager(address(usdc), signer, uint96(ONE_USDC), 10, budgetLimit);
        usdc.mint(advertiser, 100 * ONE_USDC);
        vm.stopBroadcast();

        string memory json = string.concat(
            "{\n  \"chainId\": 31337,\n  \"campaignManager\": \"",
            vm.toString(address(manager)),
            "\",\n  \"usdc\": \"",
            vm.toString(address(usdc)),
            "\",\n  \"deployBlock\": ",
            vm.toString(deployBlock),
            "\n}\n"
        );
        vm.writeFile(string.concat(vm.projectRoot(), "/deployments/31337.json"), json);
    }
}
