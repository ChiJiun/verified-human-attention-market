// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {CampaignManager} from "../src/CampaignManager.sol";

interface ScriptVm {
    function envUint(string calldata name) external view returns (uint256);
    function envAddress(string calldata name) external view returns (address);
    function startBroadcast() external;
    function stopBroadcast() external;
    function projectRoot() external view returns (string memory);
    function writeFile(string calldata path, string calldata data) external;
    function toString(address value) external pure returns (string memory);
    function toString(uint256 value) external pure returns (string memory);
}

/// @notice Reproducible CampaignManager deployment (issue #19).
/// @dev Usage (see docs/deployment/TESTNET.md):
///   forge script script/DeployCampaignManager.s.sol --rpc-url $EVM_RPC_URL --broadcast \
///     --account <foundry-keystore-account>
/// Required env: EXPECTED_CHAIN_ID, USDC_ADDRESS, CLAIM_SIGNER_ADDRESS,
/// MAX_REWARD_PER_COMPLETION, MAX_COMPLETIONS_PER_CAMPAIGN, MAX_CAMPAIGN_BUDGET.
contract DeployCampaignManager {
    ScriptVm private constant vm = ScriptVm(address(uint160(uint256(keccak256("hevm cheat code")))));

    struct DeployConfig {
        uint256 expectedChainId;
        address rewardToken;
        address authorizedSigner;
        uint256 maxRewardPerCompletion;
        uint256 maxCompletionsPerCampaign;
        uint256 maxCampaignBudget;
    }

    error WrongChain(uint256 expected, uint256 actual);
    error MissingAddress(string name);
    error NotAContract(string name);
    error LimitOutOfRange(string name);

    function run() external returns (CampaignManager manager) {
        DeployConfig memory config = DeployConfig({
            expectedChainId: vm.envUint("EXPECTED_CHAIN_ID"),
            rewardToken: vm.envAddress("USDC_ADDRESS"),
            authorizedSigner: vm.envAddress("CLAIM_SIGNER_ADDRESS"),
            maxRewardPerCompletion: vm.envUint("MAX_REWARD_PER_COMPLETION"),
            maxCompletionsPerCampaign: vm.envUint("MAX_COMPLETIONS_PER_CAMPAIGN"),
            maxCampaignBudget: vm.envUint("MAX_CAMPAIGN_BUDGET")
        });

        validate(config);

        uint256 deployBlock = block.number;

        vm.startBroadcast();
        manager = deploy(config);
        vm.stopBroadcast();

        string memory path = string.concat(vm.projectRoot(), "/deployments/", vm.toString(block.chainid), ".json");
        vm.writeFile(path, deploymentJson(config, manager, deployBlock));
    }

    /// @notice Fails fast on wrong chain, missing addresses or out-of-range limits.
    function validate(DeployConfig memory config) public view {
        if (block.chainid != config.expectedChainId) {
            revert WrongChain(config.expectedChainId, block.chainid);
        }
        if (config.rewardToken == address(0)) revert MissingAddress("USDC_ADDRESS");
        if (config.authorizedSigner == address(0)) revert MissingAddress("CLAIM_SIGNER_ADDRESS");
        if (config.rewardToken.code.length == 0) revert NotAContract("USDC_ADDRESS");
        if (config.maxRewardPerCompletion > type(uint96).max) revert LimitOutOfRange("MAX_REWARD_PER_COMPLETION");
        if (config.maxCompletionsPerCampaign > type(uint32).max) {
            revert LimitOutOfRange("MAX_COMPLETIONS_PER_CAMPAIGN");
        }
        if (config.maxCampaignBudget > type(uint128).max) revert LimitOutOfRange("MAX_CAMPAIGN_BUDGET");
    }

    function deploy(DeployConfig memory config) public returns (CampaignManager) {
        validate(config);

        return new CampaignManager(
            config.rewardToken,
            config.authorizedSigner,
            uint96(config.maxRewardPerCompletion),
            uint32(config.maxCompletionsPerCampaign),
            uint128(config.maxCampaignBudget)
        );
    }

    function deploymentJson(DeployConfig memory config, CampaignManager manager, uint256 deployBlock)
        public
        view
        returns (string memory)
    {
        string memory head = string.concat(
            "{\n",
            "  \"chainId\": ",
            vm.toString(block.chainid),
            ",\n",
            "  \"campaignManager\": \"",
            vm.toString(address(manager)),
            "\",\n",
            "  \"deployBlock\": ",
            vm.toString(deployBlock),
            ",\n",
            "  \"owner\": \"",
            vm.toString(manager.owner()),
            "\",\n"
        );

        string memory tail = string.concat(
            "  \"authorizedSigner\": \"",
            vm.toString(config.authorizedSigner),
            "\",\n",
            "  \"rewardToken\": \"",
            vm.toString(config.rewardToken),
            "\",\n",
            "  \"maxRewardPerCompletion\": \"",
            vm.toString(config.maxRewardPerCompletion),
            "\",\n",
            "  \"maxCompletionsPerCampaign\": ",
            vm.toString(config.maxCompletionsPerCampaign),
            ",\n",
            "  \"maxCampaignBudget\": \"",
            vm.toString(config.maxCampaignBudget),
            "\"\n}\n"
        );

        return string.concat(head, tail);
    }
}
