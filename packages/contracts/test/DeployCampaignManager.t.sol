// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {CampaignManager} from "../src/CampaignManager.sol";
import {DeployCampaignManager} from "../script/DeployCampaignManager.s.sol";

interface DeployTestVm {
    function expectRevert(bytes calldata revertData) external;
}

contract TokenStub {}

contract DeployCampaignManagerTest {
    DeployTestVm private constant vm = DeployTestVm(address(uint160(uint256(keccak256("hevm cheat code")))));

    DeployCampaignManager private script;
    address private token;

    function setUp() public {
        script = new DeployCampaignManager();
        token = address(new TokenStub());
    }

    function _config() private view returns (DeployCampaignManager.DeployConfig memory) {
        return DeployCampaignManager.DeployConfig({
            expectedChainId: block.chainid,
            rewardToken: token,
            authorizedSigner: address(0x5160),
            maxRewardPerCompletion: 1_000_000,
            maxCompletionsPerCampaign: 10,
            maxCampaignBudget: 10_000_000
        });
    }

    function test_DeploysWithConfiguredLimits() public {
        CampaignManager manager = script.deploy(_config());

        require(address(manager.rewardToken()) == token, "token");
        require(manager.authorizedSigner() == address(0x5160), "signer");
        require(manager.maxRewardPerCompletion() == 1_000_000, "reward limit");
        require(manager.maxCompletionsPerCampaign() == 10, "completion limit");
        require(manager.maxCampaignBudget() == 10_000_000, "budget limit");
    }

    function test_WrongChainFailsFast() public {
        DeployCampaignManager.DeployConfig memory config = _config();
        config.expectedChainId = block.chainid + 1;

        vm.expectRevert(
            abi.encodeWithSelector(DeployCampaignManager.WrongChain.selector, block.chainid + 1, block.chainid)
        );
        script.deploy(config);
    }

    function test_MissingAddressesFailFast() public {
        DeployCampaignManager.DeployConfig memory config = _config();
        config.rewardToken = address(0);

        vm.expectRevert(abi.encodeWithSelector(DeployCampaignManager.MissingAddress.selector, "USDC_ADDRESS"));
        script.deploy(config);

        config = _config();
        config.authorizedSigner = address(0);

        vm.expectRevert(abi.encodeWithSelector(DeployCampaignManager.MissingAddress.selector, "CLAIM_SIGNER_ADDRESS"));
        script.deploy(config);
    }

    function test_TokenWithoutCodeRejected() public {
        DeployCampaignManager.DeployConfig memory config = _config();
        config.rewardToken = address(0xBEEF);

        vm.expectRevert(abi.encodeWithSelector(DeployCampaignManager.NotAContract.selector, "USDC_ADDRESS"));
        script.deploy(config);
    }

    function test_OutOfRangeLimitRejected() public {
        DeployCampaignManager.DeployConfig memory config = _config();
        config.maxRewardPerCompletion = uint256(type(uint96).max) + 1;

        vm.expectRevert(
            abi.encodeWithSelector(DeployCampaignManager.LimitOutOfRange.selector, "MAX_REWARD_PER_COMPLETION")
        );
        script.deploy(config);
    }

    function test_DeploymentJsonRecordsAuditFields() public {
        CampaignManager manager = script.deploy(_config());
        string memory json = script.deploymentJson(_config(), manager, 42);

        require(bytes(json).length > 200, "json");
    }
}
