// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {CampaignManager} from "../src/CampaignManager.sol";

/// @notice Pins the event topics / selectors hard-coded in the API indexer
/// (apps/api/src/chain/abi.ts). apps/api/test/chain-abi.test.ts checks that
/// the TypeScript constants equal the literals below.
contract EventTopicsTest {
    bytes32 private constant CAMPAIGN_CREATED = 0xf3348c2e50fe353e9cd201b3e8519e71ced29fb2cbdb01e9e249be48e4e63084;
    bytes32 private constant CAMPAIGN_FUNDED = 0x318daf69d77e946364e804495b2184222324b99fddeb42ab5fd25a919f596e8c;
    bytes32 private constant REWARD_CLAIMED = 0x26b1605560a38613ed768e913564f2d9a454c54f88abaeb323ce9a8a8f79ed65;
    bytes32 private constant CAMPAIGN_CLOSED = 0x5e6eb33a418de5dbbc17f989f7ae362cdfbb1748c5d603137c767027a354edbc;
    bytes32 private constant CAMPAIGN_REFUNDED = 0xce0a95a6a92352cb9e5619426cd86ee5bb0cb44739ad6a7b1a0683d4cd16e536;
    bytes32 private constant CAMPAIGN_CANCELLED = 0x403b6718db13878ac16c27decb08f09d3a10f116c7c25af575ff5bfbc11ae9e6;
    bytes32 private constant SIGNER_UPDATED = 0x2d025324f0a785e8c12d0a0d91a9caa49df4ef20ff87e0df7213a1d4f3157beb;
    bytes32 private constant PAUSED_STATE_CHANGED = 0x9e3a5e37224532dea67b89face185703738a228a6e8a23dee546960180d3be64;
    bytes32 private constant OWNERSHIP_TRANSFERRED = 0x8be0079c531659141344cd1fd0a4f28419497f9722a3daafe3b4186f6b6457e0;

    function test_EventTopicsMatchIndexer() public pure {
        require(CampaignManager.CampaignCreated.selector == CAMPAIGN_CREATED, "CampaignCreated");
        require(CampaignManager.CampaignFunded.selector == CAMPAIGN_FUNDED, "CampaignFunded");
        require(CampaignManager.RewardClaimed.selector == REWARD_CLAIMED, "RewardClaimed");
        require(CampaignManager.CampaignClosed.selector == CAMPAIGN_CLOSED, "CampaignClosed");
        require(CampaignManager.CampaignRefunded.selector == CAMPAIGN_REFUNDED, "CampaignRefunded");
        require(CampaignManager.CampaignCancelled.selector == CAMPAIGN_CANCELLED, "CampaignCancelled");
        require(CampaignManager.SignerUpdated.selector == SIGNER_UPDATED, "SignerUpdated");
        require(CampaignManager.PausedStateChanged.selector == PAUSED_STATE_CHANGED, "PausedStateChanged");
        require(CampaignManager.OwnershipTransferred.selector == OWNERSHIP_TRANSFERRED, "OwnershipTransferred");
    }

    function test_FunctionSelectorsMatchIndexer() public view {
        // `campaigns` is a public-variable getter, so it needs an instance.
        CampaignManager manager = CampaignManager(address(0));
        require(manager.campaigns.selector == bytes4(0x141961bc), "campaigns");
        require(CampaignManager.createCampaign.selector == bytes4(0x646c64f3), "createCampaign");
        require(CampaignManager.fundCampaign.selector == bytes4(0x918eab15), "fundCampaign");
        require(manager.campaignIdByDraft.selector == bytes4(0x6003492a), "campaignIdByDraft");
    }
}
