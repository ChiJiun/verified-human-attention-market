// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {CampaignManager} from "../src/CampaignManager.sol";

interface Vm {
    function addr(uint256 privateKey) external returns (address);
    function sign(uint256 privateKey, bytes32 digest) external returns (uint8 v, bytes32 r, bytes32 s);
    function prank(address sender) external;
    function warp(uint256 newTimestamp) external;
    function expectRevert(bytes4 revertData) external;
}

contract MockUSDC {
    string public constant name = "Mock USDC";
    string public constant symbol = "mUSDC";
    uint8 public constant decimals = 6;

    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        _transfer(msg.sender, to, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        uint256 currentAllowance = allowance[from][msg.sender];
        require(currentAllowance >= amount, "allowance");

        if (currentAllowance != type(uint256).max) {
            allowance[from][msg.sender] = currentAllowance - amount;
        }

        _transfer(from, to, amount);
        return true;
    }

    function _transfer(address from, address to, uint256 amount) private {
        require(balanceOf[from] >= amount, "balance");
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
    }
}

contract CampaignManagerTest {
    Vm private constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    uint256 private constant SIGNER_KEY = 0xA11CE;
    uint256 private constant OTHER_SIGNER_KEY = 0xBAD;
    uint256 private constant CLAIMANT_KEY = 0xB0B;

    uint256 private constant ONE_USDC = 1_000_000;
    uint32 private constant MAX_COMPLETIONS = 10;

    MockUSDC private token;
    CampaignManager private manager;

    address private signer;
    address private claimant;
    address private advertiser = address(0xA11);

    uint64 private startTime;
    uint64 private endTime;

    function setUp() public {
        signer = vm.addr(SIGNER_KEY);
        claimant = vm.addr(CLAIMANT_KEY);

        token = new MockUSDC();
        manager = new CampaignManager(
            address(token), signer, uint96(ONE_USDC), MAX_COMPLETIONS, uint128(ONE_USDC * MAX_COMPLETIONS)
        );

        startTime = uint64(block.timestamp + 1);
        endTime = startTime + 1 hours;

        token.mint(advertiser, ONE_USDC * MAX_COMPLETIONS);
    }

    function test_CreateFundAndClaim() public {
        uint256 campaignId = _createAndFund(MAX_COMPLETIONS);

        vm.warp(startTime);

        CampaignManager.ClaimAuthorization memory authorization =
            _authorization(campaignId, claimant, keccak256("claim-1"));

        bytes memory signature = _sign(authorization, SIGNER_KEY);

        vm.prank(claimant);
        manager.claim(authorization, signature);

        require(token.balanceOf(claimant) == ONE_USDC, "claimant reward");
        (,, uint128 paidRewards,,, uint32 paidCompletions,,,,) = manager.campaigns(campaignId);
        require(paidRewards == ONE_USDC, "paid rewards");
        require(paidCompletions == 1, "paid completions");
    }

    function test_InvalidSignerRejected() public {
        uint256 campaignId = _createAndFund(MAX_COMPLETIONS);
        vm.warp(startTime);

        CampaignManager.ClaimAuthorization memory authorization =
            _authorization(campaignId, claimant, keccak256("bad-signer"));
        bytes memory signature = _sign(authorization, OTHER_SIGNER_KEY);

        vm.expectRevert(CampaignManager.InvalidSignature.selector);
        vm.prank(claimant);
        manager.claim(authorization, signature);
    }

    function test_WrongClaimantRejected() public {
        uint256 campaignId = _createAndFund(MAX_COMPLETIONS);
        vm.warp(startTime);

        CampaignManager.ClaimAuthorization memory authorization =
            _authorization(campaignId, claimant, keccak256("wrong-claimant"));
        bytes memory signature = _sign(authorization, SIGNER_KEY);

        vm.expectRevert(CampaignManager.WrongClaimant.selector);
        vm.prank(address(0xCAFE));
        manager.claim(authorization, signature);
    }

    function test_ExpiredAuthorizationRejected() public {
        uint256 campaignId = _createAndFund(MAX_COMPLETIONS);
        vm.warp(startTime);

        CampaignManager.ClaimAuthorization memory authorization =
            _authorization(campaignId, claimant, keccak256("expired"));
        bytes memory signature = _sign(authorization, SIGNER_KEY);

        vm.warp(uint256(authorization.expiresAt) + 1);

        vm.expectRevert(CampaignManager.AuthorizationExpired.selector);
        vm.prank(claimant);
        manager.claim(authorization, signature);
    }

    function test_DuplicateNonceRejected() public {
        uint256 campaignId = _createAndFund(MAX_COMPLETIONS);
        vm.warp(startTime);

        bytes32 nonce = keccak256("same-nonce");
        CampaignManager.ClaimAuthorization memory first = _authorization(campaignId, claimant, nonce);
        bytes memory firstSignature = _sign(first, SIGNER_KEY);

        vm.prank(claimant);
        manager.claim(first, firstSignature);

        address secondClaimant = vm.addr(0xC0FFEE);
        CampaignManager.ClaimAuthorization memory second = _authorization(campaignId, secondClaimant, nonce);
        bytes memory secondSignature = _sign(second, SIGNER_KEY);

        vm.expectRevert(CampaignManager.NonceAlreadyUsed.selector);
        vm.prank(secondClaimant);
        manager.claim(second, secondSignature);
    }

    function test_OneWalletCannotClaimTwice() public {
        uint256 campaignId = _createAndFund(MAX_COMPLETIONS);
        vm.warp(startTime);

        CampaignManager.ClaimAuthorization memory first = _authorization(campaignId, claimant, keccak256("wallet-1"));
        bytes memory firstSignature = _sign(first, SIGNER_KEY);

        vm.prank(claimant);
        manager.claim(first, firstSignature);

        CampaignManager.ClaimAuthorization memory second = _authorization(campaignId, claimant, keccak256("wallet-2"));
        bytes memory secondSignature = _sign(second, SIGNER_KEY);

        vm.expectRevert(CampaignManager.WalletAlreadyClaimed.selector);
        vm.prank(claimant);
        manager.claim(second, secondSignature);
    }

    function test_RefundWaitsForAuthorizationGracePeriod() public {
        uint256 campaignId = _createAndFund(MAX_COMPLETIONS);
        vm.warp(startTime + 10);

        vm.prank(advertiser);
        manager.closeCampaign(campaignId);

        (,,,,,,,, uint64 closedAt,) = manager.campaigns(campaignId);

        vm.expectRevert(CampaignManager.RefundNotAvailable.selector);
        vm.prank(advertiser);
        manager.refundUnusedBudget(campaignId);

        vm.warp(uint256(closedAt) + manager.MAX_AUTHORIZATION_TTL() + 1);

        vm.prank(advertiser);
        manager.refundUnusedBudget(campaignId);

        require(token.balanceOf(advertiser) == ONE_USDC * MAX_COMPLETIONS, "full refund");
        require(manager.statusOf(campaignId) == CampaignManager.CampaignStatus.Settled, "settled");
    }

    function test_PauseBlocksClaims() public {
        uint256 campaignId = _createAndFund(MAX_COMPLETIONS);
        vm.warp(startTime);

        CampaignManager.ClaimAuthorization memory authorization =
            _authorization(campaignId, claimant, keccak256("paused"));
        bytes memory signature = _sign(authorization, SIGNER_KEY);

        manager.pause();

        vm.expectRevert(CampaignManager.Paused.selector);
        vm.prank(claimant);
        manager.claim(authorization, signature);
    }

    function test_CompletionLimitReached() public {
        uint256 campaignId = _createAndFund(1);
        vm.warp(startTime);

        CampaignManager.ClaimAuthorization memory first = _authorization(campaignId, claimant, keccak256("limit-1"));
        bytes memory firstSignature = _sign(first, SIGNER_KEY);

        vm.prank(claimant);
        manager.claim(first, firstSignature);

        address secondClaimant = vm.addr(0xC0DE);
        CampaignManager.ClaimAuthorization memory second =
            _authorization(campaignId, secondClaimant, keccak256("limit-2"));
        bytes memory secondSignature = _sign(second, SIGNER_KEY);

        vm.expectRevert(CampaignManager.CompletionLimitReached.selector);
        vm.prank(secondClaimant);
        manager.claim(second, secondSignature);
    }

    function test_OnlyAdvertiserCanRefund() public {
        uint256 campaignId = _createAndFund(MAX_COMPLETIONS);
        vm.warp(startTime + 10);

        vm.prank(advertiser);
        manager.closeCampaign(campaignId);

        (,,,,,,,, uint64 closedAt,) = manager.campaigns(campaignId);
        vm.warp(uint256(closedAt) + manager.MAX_AUTHORIZATION_TTL() + 1);

        vm.expectRevert(CampaignManager.Unauthorized.selector);
        vm.prank(address(0xDEAD));
        manager.refundUnusedBudget(campaignId);
    }

    function test_PreCloseAuthorizationRemainsClaimableAfterClose() public {
        uint256 campaignId = _createAndFund(MAX_COMPLETIONS);
        vm.warp(startTime + 10);

        CampaignManager.ClaimAuthorization memory authorization =
            _authorization(campaignId, claimant, keccak256("pre-close"));
        bytes memory signature = _sign(authorization, SIGNER_KEY);

        vm.prank(advertiser);
        manager.closeCampaign(campaignId);

        vm.prank(claimant);
        manager.claim(authorization, signature);

        require(token.balanceOf(claimant) == ONE_USDC, "pre-close claim");
    }

    function test_PostCloseAuthorizationRejected() public {
        uint256 campaignId = _createAndFund(MAX_COMPLETIONS);
        vm.warp(startTime + 10);

        vm.prank(advertiser);
        manager.closeCampaign(campaignId);

        vm.warp(block.timestamp + 1);

        CampaignManager.ClaimAuthorization memory authorization =
            _authorization(campaignId, claimant, keccak256("post-close"));
        bytes memory signature = _sign(authorization, SIGNER_KEY);

        vm.expectRevert(CampaignManager.AuthorizationIssuedAfterDeadline.selector);
        vm.prank(claimant);
        manager.claim(authorization, signature);
    }

    function testFuzz_FundingEqualsMaximumLiability(uint96 rewardSeed, uint32 completionSeed) public {
        uint96 reward = uint96((uint256(rewardSeed) % manager.maxRewardPerCompletion()) + 1);
        uint32 completions = uint32((uint256(completionSeed) % manager.maxCompletionsPerCampaign()) + 1);

        uint256 requiredBudget = uint256(reward) * uint256(completions);
        token.mint(advertiser, requiredBudget);

        uint64 localStart = uint64(block.timestamp + 1);
        uint64 localEnd = localStart + 30 minutes;

        vm.prank(advertiser);
        uint256 campaignId = manager.createCampaign(reward, completions, localStart, localEnd);

        vm.prank(advertiser);
        token.approve(address(manager), requiredBudget);

        vm.prank(advertiser);
        manager.fundCampaign(campaignId, requiredBudget);

        (, uint128 fundedBudget,,,,,,,,) = manager.campaigns(campaignId);
        require(fundedBudget == requiredBudget, "funded budget");
        require(fundedBudget <= manager.maxCampaignBudget(), "budget limit");
        require(token.balanceOf(address(manager)) >= requiredBudget, "escrow balance");
    }

    function test_ExposureLimitBoundariesAccepted() public {
        vm.prank(advertiser);
        uint256 campaignId = manager.createCampaign(uint96(ONE_USDC), MAX_COMPLETIONS, startTime, endTime);

        (,,, uint96 reward, uint32 completions,,,,,) = manager.campaigns(campaignId);
        require(reward == ONE_USDC && completions == MAX_COMPLETIONS, "boundary stored");
    }

    function test_RewardAboveLimitRejected() public {
        vm.expectRevert(CampaignManager.RewardAboveLimit.selector);
        vm.prank(advertiser);
        manager.createCampaign(uint96(ONE_USDC + 1), 1, startTime, endTime);
    }

    function test_CompletionsAboveLimitRejected() public {
        vm.expectRevert(CampaignManager.CompletionsAboveLimit.selector);
        vm.prank(advertiser);
        manager.createCampaign(1, MAX_COMPLETIONS + 1, startTime, endTime);
    }

    function test_VeryLargeDirectCallsRejected() public {
        vm.expectRevert(CampaignManager.RewardAboveLimit.selector);
        vm.prank(advertiser);
        manager.createCampaign(type(uint96).max, type(uint32).max, startTime, endTime);

        vm.expectRevert(CampaignManager.CompletionsAboveLimit.selector);
        vm.prank(advertiser);
        manager.createCampaign(1, type(uint32).max, startTime, endTime);
    }

    function test_BudgetAboveLimitRejected() public {
        CampaignManager tight =
            new CampaignManager(address(token), signer, uint96(ONE_USDC), MAX_COMPLETIONS, uint128(5 * ONE_USDC));

        tight.createCampaign(uint96(ONE_USDC), 5, startTime, endTime);

        vm.expectRevert(CampaignManager.BudgetAboveLimit.selector);
        tight.createCampaign(uint96(ONE_USDC), 6, startTime, endTime);
    }

    function testFuzz_CreateNeverExceedsExposureLimits(uint96 reward, uint32 completions) public {
        if (reward == 0 || completions == 0) return;

        vm.prank(advertiser);
        try manager.createCampaign(reward, completions, startTime, endTime) returns (uint256 campaignId) {
            (,,, uint96 storedReward, uint32 storedCompletions,,,,,) = manager.campaigns(campaignId);
            require(storedReward <= manager.maxRewardPerCompletion(), "reward limit");
            require(storedCompletions <= manager.maxCompletionsPerCampaign(), "completion limit");
            require(uint256(storedReward) * uint256(storedCompletions) <= manager.maxCampaignBudget(), "budget limit");
        } catch {}
    }

    function test_InvalidExposureLimitsRejected() public {
        vm.expectRevert(CampaignManager.InvalidExposureLimits.selector);
        new CampaignManager(address(token), signer, 0, MAX_COMPLETIONS, uint128(ONE_USDC));

        vm.expectRevert(CampaignManager.InvalidExposureLimits.selector);
        new CampaignManager(address(token), signer, uint96(ONE_USDC), 0, uint128(ONE_USDC));

        vm.expectRevert(CampaignManager.InvalidExposureLimits.selector);
        new CampaignManager(address(token), signer, uint96(ONE_USDC), MAX_COMPLETIONS, uint128(ONE_USDC - 1));
    }

    function test_FundingAfterEndRejected() public {
        vm.prank(advertiser);
        uint256 campaignId = manager.createCampaign(uint96(ONE_USDC), MAX_COMPLETIONS, startTime, endTime);

        vm.prank(advertiser);
        token.approve(address(manager), ONE_USDC * MAX_COMPLETIONS);

        vm.warp(endTime);

        vm.expectRevert(CampaignManager.CampaignAlreadyEnded.selector);
        vm.prank(advertiser);
        manager.fundCampaign(campaignId, ONE_USDC * MAX_COMPLETIONS);
    }

    function test_CancelUnfundedDraft() public {
        vm.prank(advertiser);
        uint256 campaignId = manager.createCampaign(uint96(ONE_USDC), MAX_COMPLETIONS, startTime, endTime);

        vm.expectRevert(CampaignManager.Unauthorized.selector);
        vm.prank(address(0xDEAD));
        manager.cancelCampaign(campaignId);

        vm.prank(advertiser);
        manager.cancelCampaign(campaignId);

        require(manager.statusOf(campaignId) == CampaignManager.CampaignStatus.Cancelled, "cancelled");

        vm.prank(advertiser);
        token.approve(address(manager), ONE_USDC * MAX_COMPLETIONS);

        vm.expectRevert(CampaignManager.InvalidCampaignStatus.selector);
        vm.prank(advertiser);
        manager.fundCampaign(campaignId, ONE_USDC * MAX_COMPLETIONS);
    }

    function test_CannotCancelFundedCampaign() public {
        uint256 campaignId = _createAndFund(MAX_COMPLETIONS);

        vm.expectRevert(CampaignManager.InvalidCampaignStatus.selector);
        vm.prank(advertiser);
        manager.cancelCampaign(campaignId);
    }

    function _createAndFund(uint32 maxCompletions) private returns (uint256) {
        vm.prank(advertiser);
        uint256 campaignId = manager.createCampaign(uint96(ONE_USDC), maxCompletions, startTime, endTime);

        uint256 budget = ONE_USDC * maxCompletions;

        vm.prank(advertiser);
        token.approve(address(manager), budget);

        vm.prank(advertiser);
        manager.fundCampaign(campaignId, budget);

        return campaignId;
    }

    function _authorization(uint256 campaignId, address recipient, bytes32 nonce)
        private
        view
        returns (CampaignManager.ClaimAuthorization memory)
    {
        uint64 issuedAt = uint64(block.timestamp);

        return CampaignManager.ClaimAuthorization({
            campaignId: campaignId,
            claimant: recipient,
            amount: ONE_USDC,
            nonce: nonce,
            issuedAt: issuedAt,
            expiresAt: issuedAt + 10 minutes
        });
    }

    function _sign(CampaignManager.ClaimAuthorization memory authorization, uint256 privateKey)
        private
        returns (bytes memory)
    {
        bytes32 digest = manager.hashClaimAuthorization(authorization);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(privateKey, digest);
        return abi.encodePacked(r, s, v);
    }
}
