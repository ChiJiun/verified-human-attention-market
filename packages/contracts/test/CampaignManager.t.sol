// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {CampaignManager} from "../src/CampaignManager.sol";

interface Vm {
    function addr(uint256 privateKey) external returns (address);
    function sign(uint256 privateKey, bytes32 digest) external returns (uint8 v, bytes32 r, bytes32 s);
    function prank(address sender) external;
    function warp(uint256 newTimestamp) external;
    function store(address target, bytes32 slot, bytes32 value) external;
    function expectRevert(bytes4 revertData) external;
    function expectRevert(bytes calldata revertData) external;
    function expectEmit(bool checkTopic1, bool checkTopic2, bool checkTopic3, bool checkData, address emitter) external;
    function snapshotState() external returns (uint256 snapshotId);
    function revertToState(uint256 snapshotId) external returns (bool success);
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
    uint256 private constant SECP256K1_N = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141;
    // Storage slot of `CampaignManager.campaigns` (`forge inspect CampaignManager storage-layout`).
    uint256 private constant CAMPAIGNS_SLOT = 3;

    // Cross-language fixture: apps/api/test/claims.test.ts computes the same
    // value from the viem EIP-712 type definition.
    function test_ClaimAuthorizationTypehashMatchesBackend() public view {
        assert(
            manager.CLAIM_AUTHORIZATION_TYPEHASH() == 0x190486b79e77ff5517da40fe874a526fb3507c8999e73a8a70f90d4e2e90005b
        );
    }

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

    function test_SignerRotationRevokesOldSignatures() public {
        uint256 campaignId = _createAndFund(MAX_COMPLETIONS);
        vm.warp(startTime);

        CampaignManager.ClaimAuthorization memory authorization =
            _authorization(campaignId, claimant, keccak256("rotation"));
        bytes memory oldSignature = _sign(authorization, SIGNER_KEY);

        vm.expectRevert(CampaignManager.Unauthorized.selector);
        vm.prank(advertiser);
        manager.setAuthorizedSigner(vm.addr(OTHER_SIGNER_KEY));

        vm.expectRevert(CampaignManager.ZeroAddress.selector);
        manager.setAuthorizedSigner(address(0));

        manager.setAuthorizedSigner(vm.addr(OTHER_SIGNER_KEY));
        require(manager.authorizedSigner() == vm.addr(OTHER_SIGNER_KEY), "rotated");

        vm.expectRevert(CampaignManager.InvalidSignature.selector);
        vm.prank(claimant);
        manager.claim(authorization, oldSignature);

        bytes memory newSignature = _sign(authorization, OTHER_SIGNER_KEY);
        vm.prank(claimant);
        manager.claim(authorization, newSignature);
        require(token.balanceOf(claimant) == ONE_USDC, "paid by new signer");
    }

    function test_OnlyOwnerCanPauseAndPauseBlocksRefunds() public {
        uint256 campaignId = _createAndFund(MAX_COMPLETIONS);

        vm.expectRevert(CampaignManager.Unauthorized.selector);
        vm.prank(advertiser);
        manager.pause();

        manager.pause();
        vm.warp(endTime + 1 days);

        vm.expectRevert(CampaignManager.Paused.selector);
        vm.prank(advertiser);
        manager.refundUnusedBudget(campaignId);

        manager.unpause();
        vm.prank(advertiser);
        manager.refundUnusedBudget(campaignId);
        require(token.balanceOf(advertiser) == ONE_USDC * MAX_COMPLETIONS, "refund after unpause");
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

        bytes32 ref = _nextRef();
        vm.prank(advertiser);
        uint256 campaignId = manager.createCampaign(reward, completions, localStart, localEnd, ref);

        vm.prank(advertiser);
        token.approve(address(manager), requiredBudget);

        vm.prank(advertiser);
        manager.fundCampaign(campaignId, requiredBudget, ref);

        (, uint128 fundedBudget,,,,,,,,) = manager.campaigns(campaignId);
        require(fundedBudget == requiredBudget, "funded budget");
        require(fundedBudget <= manager.maxCampaignBudget(), "budget limit");
        require(token.balanceOf(address(manager)) >= requiredBudget, "escrow balance");
    }

    function test_ExposureLimitBoundariesAccepted() public {
        vm.prank(advertiser);
        uint256 campaignId = manager.createCampaign(uint96(ONE_USDC), MAX_COMPLETIONS, startTime, endTime, _nextRef());

        (,,, uint96 reward, uint32 completions,,,,,) = manager.campaigns(campaignId);
        require(reward == ONE_USDC && completions == MAX_COMPLETIONS, "boundary stored");
    }

    function test_RewardAboveLimitRejected() public {
        vm.expectRevert(CampaignManager.RewardAboveLimit.selector);
        vm.prank(advertiser);
        manager.createCampaign(uint96(ONE_USDC + 1), 1, startTime, endTime, _nextRef());
    }

    function test_CompletionsAboveLimitRejected() public {
        vm.expectRevert(CampaignManager.CompletionsAboveLimit.selector);
        vm.prank(advertiser);
        manager.createCampaign(1, MAX_COMPLETIONS + 1, startTime, endTime, _nextRef());
    }

    function test_VeryLargeDirectCallsRejected() public {
        vm.expectRevert(CampaignManager.RewardAboveLimit.selector);
        vm.prank(advertiser);
        manager.createCampaign(type(uint96).max, type(uint32).max, startTime, endTime, _nextRef());

        vm.expectRevert(CampaignManager.CompletionsAboveLimit.selector);
        vm.prank(advertiser);
        manager.createCampaign(1, type(uint32).max, startTime, endTime, _nextRef());
    }

    function test_BudgetAboveLimitRejected() public {
        CampaignManager tight =
            new CampaignManager(address(token), signer, uint96(ONE_USDC), MAX_COMPLETIONS, uint128(5 * ONE_USDC));

        tight.createCampaign(uint96(ONE_USDC), 5, startTime, endTime, _nextRef());

        vm.expectRevert(CampaignManager.BudgetAboveLimit.selector);
        tight.createCampaign(uint96(ONE_USDC), 6, startTime, endTime, _nextRef());
    }

    function testFuzz_CreateNeverExceedsExposureLimits(uint96 reward, uint32 completions) public {
        if (reward == 0 || completions == 0) return;

        vm.prank(advertiser);
        try manager.createCampaign(reward, completions, startTime, endTime, _nextRef()) returns (uint256 campaignId) {
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
        bytes32 ref = _nextRef();
        vm.prank(advertiser);
        uint256 campaignId = manager.createCampaign(uint96(ONE_USDC), MAX_COMPLETIONS, startTime, endTime, ref);

        vm.prank(advertiser);
        token.approve(address(manager), ONE_USDC * MAX_COMPLETIONS);

        vm.warp(endTime);

        vm.expectRevert(CampaignManager.CampaignAlreadyEnded.selector);
        vm.prank(advertiser);
        manager.fundCampaign(campaignId, ONE_USDC * MAX_COMPLETIONS, ref);
    }

    /// Funding names the draft it pays for: after a deep reorg the same id can
    /// belong to another draft with the same budget (ADR-0011).
    function test_FundingForAnotherDraftRejected() public {
        bytes32 ref = _nextRef();
        vm.prank(advertiser);
        uint256 campaignId = manager.createCampaign(uint96(ONE_USDC), MAX_COMPLETIONS, startTime, endTime, ref);

        vm.prank(advertiser);
        token.approve(address(manager), ONE_USDC * MAX_COMPLETIONS);

        vm.expectRevert(CampaignManager.WrongDraft.selector);
        vm.prank(advertiser);
        manager.fundCampaign(campaignId, ONE_USDC * MAX_COMPLETIONS, keccak256("another-draft"));

        // A zero reference never names a campaign either.
        vm.expectRevert(CampaignManager.WrongDraft.selector);
        vm.prank(advertiser);
        manager.fundCampaign(campaignId, ONE_USDC * MAX_COMPLETIONS, bytes32(0));

        require(token.balanceOf(address(manager)) == 0, "nothing escrowed");
        require(manager.statusOf(campaignId) == CampaignManager.CampaignStatus.Draft, "still a draft");

        vm.prank(advertiser);
        manager.fundCampaign(campaignId, ONE_USDC * MAX_COMPLETIONS, ref);
        require(manager.statusOf(campaignId) == CampaignManager.CampaignStatus.Active, "funded with its own draft");
    }

    function test_CancelUnfundedDraft() public {
        bytes32 ref = _nextRef();
        vm.prank(advertiser);
        uint256 campaignId = manager.createCampaign(uint96(ONE_USDC), MAX_COMPLETIONS, startTime, endTime, ref);

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
        manager.fundCampaign(campaignId, ONE_USDC * MAX_COMPLETIONS, ref);
    }

    function test_CannotCancelFundedCampaign() public {
        uint256 campaignId = _createAndFund(MAX_COMPLETIONS);

        vm.expectRevert(CampaignManager.InvalidCampaignStatus.selector);
        vm.prank(advertiser);
        manager.cancelCampaign(campaignId);
    }

    uint256 private draftRefCounter;
    /// @dev Draft reference each test campaign was created with.
    mapping(uint256 => bytes32) private draftRefOf;

    /// @dev A fresh, non-zero draft reference for each created campaign.
    function _nextRef() private returns (bytes32) {
        return bytes32(++draftRefCounter);
    }

    function test_DuplicateDraftRefReverts() public {
        bytes32 ref = keccak256("draft-1");
        vm.prank(advertiser);
        uint256 campaignId = manager.createCampaign(uint96(ONE_USDC), MAX_COMPLETIONS, startTime, endTime, ref);

        require(manager.campaignIdByDraft(advertiser, ref) == campaignId, "draft recorded");

        // A retried or concurrent create for the same draft never makes a second campaign.
        vm.expectRevert(abi.encodeWithSelector(CampaignManager.DraftAlreadyCreated.selector, campaignId));
        vm.prank(advertiser);
        manager.createCampaign(uint96(ONE_USDC), MAX_COMPLETIONS, startTime, endTime, ref);

        require(manager.campaignCount() == campaignId, "no second campaign");
    }

    function test_DraftRefIsScopedToTheAdvertiser() public {
        bytes32 ref = keccak256("draft-shared");
        vm.prank(address(0xBEEF));
        uint256 other = manager.createCampaign(uint96(ONE_USDC), MAX_COMPLETIONS, startTime, endTime, ref);

        // Someone else using the same reference first cannot block this advertiser.
        vm.prank(advertiser);
        uint256 own = manager.createCampaign(uint96(ONE_USDC), MAX_COMPLETIONS, startTime, endTime, ref);

        require(own != other, "separate campaigns");
        require(manager.campaignIdByDraft(advertiser, ref) == own, "own mapping");
        require(manager.campaignIdByDraft(address(0xBEEF), ref) == other, "other mapping");
    }

    function test_ZeroDraftRefRejected() public {
        vm.expectRevert(CampaignManager.InvalidDraftRef.selector);
        vm.prank(advertiser);
        manager.createCampaign(uint96(ONE_USDC), MAX_COMPLETIONS, startTime, endTime, bytes32(0));
    }

    function test_CampaignCreatedCarriesDraftRef() public {
        bytes32 ref = keccak256("draft-event");
        vm.expectEmit(true, true, true, true, address(manager));
        emit CampaignManager.CampaignCreated(1, advertiser, ref);
        vm.prank(advertiser);
        manager.createCampaign(uint96(ONE_USDC), MAX_COMPLETIONS, startTime, endTime, ref);
    }

    function test_ClaimRejectsAnotherDraftsAuthorization() public {
        uint256 campaignId = _createAndFund(MAX_COMPLETIONS);
        vm.warp(startTime);

        CampaignManager.ClaimAuthorization memory authorization =
            _authorization(campaignId, claimant, keccak256("other-draft"));
        authorization.draftRef = keccak256("not-this-campaigns-draft");
        bytes memory signature = _sign(authorization, SIGNER_KEY);

        vm.expectRevert(CampaignManager.WrongDraft.selector);
        vm.prank(claimant);
        manager.claim(authorization, signature);
    }

    /// Deep reorg on the same contract: draft A's campaign 1 disappears and
    /// draft B's creation takes id 1. A's unexpired authorization must not
    /// pay out of B's budget (ADR-0011).
    function test_AuthorizationForReorgedDraftCannotClaimTheNewCampaign() public {
        uint256 snapshot = vm.snapshotState();

        bytes32 refA = keccak256("draft-A");
        vm.prank(advertiser);
        uint256 idA = manager.createCampaign(uint96(ONE_USDC), MAX_COMPLETIONS, startTime, endTime, refA);
        vm.prank(advertiser);
        token.approve(address(manager), ONE_USDC * MAX_COMPLETIONS);
        vm.prank(advertiser);
        manager.fundCampaign(idA, ONE_USDC * MAX_COMPLETIONS, refA);
        vm.warp(startTime);

        CampaignManager.ClaimAuthorization memory authA = _authorization(idA, claimant, keccak256("nonce-A"));
        authA.draftRef = refA;
        bytes memory signatureA = _sign(authA, SIGNER_KEY);

        // The reorg: chain state rolls back, then B's creation takes the id.
        vm.revertToState(snapshot);
        bytes32 refB = keccak256("draft-B");
        vm.prank(advertiser);
        uint256 idB = manager.createCampaign(uint96(ONE_USDC), MAX_COMPLETIONS, startTime, endTime, refB);
        require(idB == idA, "same id reused");
        vm.prank(advertiser);
        token.approve(address(manager), ONE_USDC * MAX_COMPLETIONS);
        vm.prank(advertiser);
        manager.fundCampaign(idB, ONE_USDC * MAX_COMPLETIONS, refB);
        vm.warp(startTime);

        vm.expectRevert(CampaignManager.WrongDraft.selector);
        vm.prank(claimant);
        manager.claim(authA, signatureA);

        // B's own authorization still works.
        CampaignManager.ClaimAuthorization memory authB = _authorization(idB, claimant, keccak256("nonce-B"));
        authB.draftRef = refB;
        bytes memory signatureB = _sign(authB, SIGNER_KEY);
        vm.prank(claimant);
        manager.claim(authB, signatureB);
    }

    function test_InvalidClaimAmountRejected() public {
        uint256 campaignId = _createAndFund(MAX_COMPLETIONS);
        vm.warp(startTime);

        uint256[3] memory wrongAmounts = [ONE_USDC + 1, ONE_USDC - 1, 0];
        for (uint256 i; i < wrongAmounts.length; ++i) {
            CampaignManager.ClaimAuthorization memory authorization =
                _authorization(campaignId, claimant, keccak256("wrong-amount"));
            authorization.amount = wrongAmounts[i];
            bytes memory signature = _sign(authorization, SIGNER_KEY);

            vm.expectRevert(CampaignManager.InvalidClaimAmount.selector);
            vm.prank(claimant);
            manager.claim(authorization, signature);
        }
    }

    function test_AuthorizationNotYetValidRejected() public {
        uint256 campaignId = _createAndFund(MAX_COMPLETIONS);
        vm.warp(startTime);

        CampaignManager.ClaimAuthorization memory authorization =
            _authorization(campaignId, claimant, keccak256("future"));
        authorization.issuedAt += 1;
        authorization.expiresAt += 1;
        bytes memory signature = _sign(authorization, SIGNER_KEY);

        vm.expectRevert(CampaignManager.AuthorizationNotYetValid.selector);
        vm.prank(claimant);
        manager.claim(authorization, signature);

        vm.warp(authorization.issuedAt);
        vm.prank(claimant);
        manager.claim(authorization, signature);
    }

    function test_AuthorizationLifetimeTooLongRejected() public {
        uint256 campaignId = _createAndFund(MAX_COMPLETIONS);
        vm.warp(startTime);

        CampaignManager.ClaimAuthorization memory authorization =
            _authorization(campaignId, claimant, keccak256("overlong"));
        authorization.expiresAt = authorization.issuedAt + manager.MAX_AUTHORIZATION_TTL() + 1;
        bytes memory signature = _sign(authorization, SIGNER_KEY);

        vm.expectRevert(CampaignManager.AuthorizationLifetimeTooLong.selector);
        vm.prank(claimant);
        manager.claim(authorization, signature);

        authorization.expiresAt = authorization.issuedAt + manager.MAX_AUTHORIZATION_TTL();
        signature = _sign(authorization, SIGNER_KEY);
        vm.prank(claimant);
        manager.claim(authorization, signature);
    }

    /// The `expiresAt <= issuedAt` half of the lifetime guard never fires on its own.
    /// NotYetValid and Expired already reject every authorization that meets it.
    function test_InvertedAuthorizationWindowRejected() public {
        uint256 campaignId = _createAndFund(MAX_COMPLETIONS);
        vm.warp(startTime);

        CampaignManager.ClaimAuthorization memory authorization =
            _authorization(campaignId, claimant, keccak256("inverted"));
        authorization.expiresAt = authorization.issuedAt;
        bytes memory signature = _sign(authorization, SIGNER_KEY);

        vm.expectRevert(CampaignManager.AuthorizationExpired.selector);
        vm.prank(claimant);
        manager.claim(authorization, signature);

        authorization.issuedAt += 10 minutes;
        authorization.expiresAt = authorization.issuedAt - 5 minutes;
        signature = _sign(authorization, SIGNER_KEY);

        vm.expectRevert(CampaignManager.AuthorizationNotYetValid.selector);
        vm.prank(claimant);
        manager.claim(authorization, signature);
    }

    /// The lower bound of the issuance window reverts with the same error as the upper bound.
    function test_AuthorizationIssuedBeforeStartRejected() public {
        uint256 campaignId = _createAndFund(MAX_COMPLETIONS);
        vm.warp(startTime - 1);

        CampaignManager.ClaimAuthorization memory authorization =
            _authorization(campaignId, claimant, keccak256("early"));
        bytes memory signature = _sign(authorization, SIGNER_KEY);

        vm.expectRevert(CampaignManager.AuthorizationIssuedAfterDeadline.selector);
        vm.prank(claimant);
        manager.claim(authorization, signature);

        vm.warp(startTime);
        authorization = _authorization(campaignId, claimant, keccak256("on-time"));
        signature = _sign(authorization, SIGNER_KEY);
        vm.prank(claimant);
        manager.claim(authorization, signature);
    }

    /// A campaign that was never closed accepts no authorization issued after its end. Refund opens once the
    /// end plus MAX_AUTHORIZATION_TTL has passed, and a later authorization could outlive that wait.
    function test_AuthorizationIssuedAfterEndRejected() public {
        uint256 campaignId = _createAndFund(MAX_COMPLETIONS);

        vm.warp(endTime);
        CampaignManager.ClaimAuthorization memory onTime =
            _authorization(campaignId, claimant, keccak256("last-second"));
        bytes memory onTimeSignature = _sign(onTime, SIGNER_KEY);

        vm.warp(endTime + 1);
        CampaignManager.ClaimAuthorization memory late = _authorization(campaignId, claimant, keccak256("after-end"));
        bytes memory lateSignature = _sign(late, SIGNER_KEY);

        vm.expectRevert(CampaignManager.AuthorizationIssuedAfterDeadline.selector);
        vm.prank(claimant);
        manager.claim(late, lateSignature);

        vm.prank(claimant);
        manager.claim(onTime, onTimeSignature);
        require(token.balanceOf(claimant) == ONE_USDC, "last-second authorization pays after the end");
    }

    function test_InvalidSignatureLengthRejected() public {
        uint256 campaignId = _createAndFund(MAX_COMPLETIONS);
        vm.warp(startTime);

        CampaignManager.ClaimAuthorization memory authorization =
            _authorization(campaignId, claimant, keccak256("bad-length"));
        (uint8 v, bytes32 r, bytes32 s) = _signComponents(authorization, SIGNER_KEY);

        // Without the length check the 66-byte form would recover, because its trailing byte is never read.
        bytes[3] memory badSignatures = [bytes(""), abi.encodePacked(r, s), abi.encodePacked(r, s, v, uint8(0))];
        for (uint256 i; i < badSignatures.length; ++i) {
            vm.expectRevert(CampaignManager.InvalidSignatureLength.selector);
            vm.prank(claimant);
            manager.claim(authorization, badSignatures[i]);
        }

        vm.prank(claimant);
        manager.claim(authorization, abi.encodePacked(r, s, v));
    }

    function test_InvalidSignatureSRejected() public {
        uint256 campaignId = _createAndFund(MAX_COMPLETIONS);
        vm.warp(startTime);

        CampaignManager.ClaimAuthorization memory authorization =
            _authorization(campaignId, claimant, keccak256("high-s"));
        (uint8 v, bytes32 r, bytes32 s) = _signComponents(authorization, SIGNER_KEY);

        // (r, n - s, flipped v) is the second valid encoding of the same signature.
        bytes32 highS = bytes32(SECP256K1_N - uint256(s));
        uint8 flippedV = v == 27 ? 28 : 27;
        bytes32 digest = manager.hashClaimAuthorization(authorization);
        require(ecrecover(digest, flippedV, r, highS) == signer, "malleated signature recovers the signer");

        vm.expectRevert(CampaignManager.InvalidSignatureS.selector);
        vm.prank(claimant);
        manager.claim(authorization, abi.encodePacked(r, highS, flippedV));

        vm.prank(claimant);
        manager.claim(authorization, abi.encodePacked(r, s, v));
    }

    function test_InvalidSignatureVRejected() public {
        uint256 campaignId = _createAndFund(MAX_COMPLETIONS);
        vm.warp(startTime);

        CampaignManager.ClaimAuthorization memory authorization =
            _authorization(campaignId, claimant, keccak256("bad-v"));
        (, bytes32 r, bytes32 s) = _signComponents(authorization, SIGNER_KEY);

        // The contract lifts 0 and 1 to 27 and 28, so the rejected range is 2..26 and 29..255.
        uint8[4] memory badV = [2, 26, 29, 255];
        for (uint256 i; i < badV.length; ++i) {
            vm.expectRevert(CampaignManager.InvalidSignatureV.selector);
            vm.prank(claimant);
            manager.claim(authorization, abi.encodePacked(r, s, badV[i]));
        }
    }

    function test_InvalidFundingAmountRejected() public {
        bytes32 ref = _nextRef();
        vm.prank(advertiser);
        uint256 campaignId = manager.createCampaign(uint96(ONE_USDC), MAX_COMPLETIONS, startTime, endTime, ref);

        uint256 required = ONE_USDC * MAX_COMPLETIONS;
        vm.prank(advertiser);
        token.approve(address(manager), required);

        uint256[3] memory wrongAmounts = [required - 1, required + 1, 0];
        for (uint256 i; i < wrongAmounts.length; ++i) {
            vm.expectRevert(CampaignManager.InvalidFundingAmount.selector);
            vm.prank(advertiser);
            manager.fundCampaign(campaignId, wrongAmounts[i], ref);
        }

        require(token.balanceOf(address(manager)) == 0, "nothing escrowed");
        require(manager.statusOf(campaignId) == CampaignManager.CampaignStatus.Draft, "still a draft");

        vm.prank(advertiser);
        manager.fundCampaign(campaignId, required, ref);
        require(manager.statusOf(campaignId) == CampaignManager.CampaignStatus.Active, "exact amount funds");
    }

    /// A second funding call is stopped by the status guard before it can reach AlreadyFunded.
    function test_FundingTwiceRejected() public {
        uint256 campaignId = _createAndFund(MAX_COMPLETIONS);

        vm.expectRevert(CampaignManager.InvalidCampaignStatus.selector);
        vm.prank(advertiser);
        manager.fundCampaign(campaignId, ONE_USDC * MAX_COMPLETIONS, draftRefOf[campaignId]);
    }

    /// No public sequence reaches this guard. Funding sets the budget and leaves Draft in
    /// the same transaction, so a Draft that already holds a budget cannot exist.
    function test_AlreadyFundedRejected() public {
        bytes32 ref = _nextRef();
        vm.prank(advertiser);
        uint256 campaignId = manager.createCampaign(uint96(ONE_USDC), MAX_COMPLETIONS, startTime, endTime, ref);
        vm.prank(advertiser);
        token.approve(address(manager), ONE_USDC * MAX_COMPLETIONS);
        _setBudgetAccounting(campaignId, 1, 0);

        vm.expectRevert(CampaignManager.AlreadyFunded.selector);
        vm.prank(advertiser);
        manager.fundCampaign(campaignId, ONE_USDC * MAX_COMPLETIONS, ref);
    }

    /// No public sequence reaches this guard. Each claim adds exactly one reward and one
    /// completion to a budget of reward * maxCompletions, so CompletionLimitReached always
    /// fires first. The guard stops a campaign from paying out of the escrow of other campaigns.
    function test_InsufficientCampaignBudgetRejected() public {
        uint256 campaignId = _createAndFund(MAX_COMPLETIONS);
        vm.warp(startTime);

        CampaignManager.ClaimAuthorization memory authorization =
            _authorization(campaignId, claimant, keccak256("no-budget"));
        bytes memory signature = _sign(authorization, SIGNER_KEY);

        uint128 reward = uint128(ONE_USDC);
        uint128 budget = reward * MAX_COMPLETIONS;
        _setBudgetAccounting(campaignId, budget, budget - reward + 1);

        vm.expectRevert(CampaignManager.InsufficientCampaignBudget.selector);
        vm.prank(claimant);
        manager.claim(authorization, signature);

        _setBudgetAccounting(campaignId, budget, budget - reward);
        vm.prank(claimant);
        manager.claim(authorization, signature);
    }

    function testFuzz_CampaignDurationBounds(bool aroundMax, uint8 step, uint32 startDelay) public {
        uint64 minDuration = manager.MIN_CAMPAIGN_DURATION();
        uint64 maxDuration = manager.MAX_CAMPAIGN_DURATION();
        // One second below, at and above the chosen bound.
        uint64 duration = (aroundMax ? maxDuration : minDuration) - 1 + (step % 3);
        uint64 start = uint64(block.timestamp) + startDelay;
        uint64 end = start + duration;

        if (duration >= minDuration && duration <= maxDuration) {
            uint256 campaignId = _createWindow(start, end);
            (,,,,,, uint64 storedStart, uint64 storedEnd,,) = manager.campaigns(campaignId);
            require(storedStart == start && storedEnd == end, "window stored");
        } else {
            vm.expectRevert(CampaignManager.InvalidCampaignWindow.selector);
            _createWindow(start, end);
        }
    }

    function testFuzz_CampaignStartInThePastRejected(uint256 secondsAgo) public {
        vm.warp(30 days);
        uint64 start = uint64(block.timestamp - 1 - (secondsAgo % block.timestamp));
        uint64 end = start + manager.MIN_CAMPAIGN_DURATION();

        vm.expectRevert(CampaignManager.InvalidCampaignWindow.selector);
        _createWindow(start, end);
    }

    function test_CampaignWindowEdges() public {
        vm.warp(1 days);
        uint64 current = uint64(block.timestamp);
        uint64 minDuration = manager.MIN_CAMPAIGN_DURATION();
        uint64 maxDuration = manager.MAX_CAMPAIGN_DURATION();

        // Starting this very second is allowed.
        _createWindow(current, current + minDuration);
        _createWindow(current, current + maxDuration);

        vm.expectRevert(CampaignManager.InvalidCampaignWindow.selector);
        _createWindow(current - 1, current - 1 + minDuration);

        vm.expectRevert(CampaignManager.InvalidCampaignWindow.selector);
        _createWindow(current, current);

        // An end before the start must revert with the window error, not an underflow panic.
        vm.expectRevert(CampaignManager.InvalidCampaignWindow.selector);
        _createWindow(current + minDuration, current);
    }

    function _createAndFund(uint32 maxCompletions) private returns (uint256) {
        bytes32 ref = _nextRef();
        vm.prank(advertiser);
        uint256 campaignId = manager.createCampaign(uint96(ONE_USDC), maxCompletions, startTime, endTime, ref);
        draftRefOf[campaignId] = ref;

        uint256 budget = ONE_USDC * maxCompletions;

        vm.prank(advertiser);
        token.approve(address(manager), budget);

        vm.prank(advertiser);
        manager.fundCampaign(campaignId, budget, ref);

        return campaignId;
    }

    function _createWindow(uint64 start, uint64 end) private returns (uint256) {
        vm.prank(advertiser);
        return manager.createCampaign(uint96(ONE_USDC), 1, start, end, _nextRef());
    }

    /// @dev fundedBudget and paidRewards share the second slot of the Campaign struct. The
    /// values are read back through the getter so a moved slot fails here instead of
    /// silently exercising a different state.
    function _setBudgetAccounting(uint256 campaignId, uint128 fundedBudget, uint128 paidRewards) private {
        bytes32 slot = bytes32(uint256(keccak256(abi.encode(campaignId, CAMPAIGNS_SLOT))) + 1);
        vm.store(address(manager), slot, bytes32((uint256(paidRewards) << 128) | fundedBudget));

        (, uint128 funded, uint128 paid,,,,,,,) = manager.campaigns(campaignId);
        require(funded == fundedBudget && paid == paidRewards, "campaign storage layout changed");
    }

    function _authorization(uint256 campaignId, address recipient, bytes32 nonce)
        private
        view
        returns (CampaignManager.ClaimAuthorization memory)
    {
        uint64 issuedAt = uint64(block.timestamp);

        return CampaignManager.ClaimAuthorization({
            campaignId: campaignId,
            draftRef: draftRefOf[campaignId],
            claimant: recipient,
            amount: ONE_USDC,
            nonce: nonce,
            issuedAt: issuedAt,
            expiresAt: issuedAt + 10 minutes
        });
    }

    function _signComponents(CampaignManager.ClaimAuthorization memory authorization, uint256 privateKey)
        private
        returns (uint8 v, bytes32 r, bytes32 s)
    {
        bytes32 digest = manager.hashClaimAuthorization(authorization);
        return vm.sign(privateKey, digest);
    }

    function _sign(CampaignManager.ClaimAuthorization memory authorization, uint256 privateKey)
        private
        returns (bytes memory)
    {
        (uint8 v, bytes32 r, bytes32 s) = _signComponents(authorization, privateKey);
        return abi.encodePacked(r, s, v);
    }
}
