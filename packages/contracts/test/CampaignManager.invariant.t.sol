// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {CampaignManager} from "../src/CampaignManager.sol";

interface InvariantVm {
    function addr(uint256 privateKey) external returns (address);
    function sign(uint256 privateKey, bytes32 digest) external returns (uint8 v, bytes32 r, bytes32 s);
    function prank(address sender) external;
    function warp(uint256 newTimestamp) external;
}

contract InvariantUSDC {
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

        allowance[from][msg.sender] = currentAllowance - amount;
        _transfer(from, to, amount);
        return true;
    }

    function _transfer(address from, address to, uint256 amount) private {
        require(balanceOf[from] >= amount, "balance");

        balanceOf[from] -= amount;
        balanceOf[to] += amount;
    }
}

contract CampaignInvariantHandler {
    InvariantVm private constant vm = InvariantVm(address(uint160(uint256(keccak256("hevm cheat code")))));

    CampaignManager public immutable manager;
    InvariantUSDC public immutable token;

    uint256 public immutable campaignId;
    uint256 public immutable signerKey;
    address public immutable advertiser;

    uint256 public totalClaimed;

    constructor(
        CampaignManager manager_,
        InvariantUSDC token_,
        uint256 campaignId_,
        uint256 signerKey_,
        address advertiser_
    ) {
        manager = manager_;
        token = token_;
        campaignId = campaignId_;
        signerKey = signerKey_;
        advertiser = advertiser_;
    }

    function claim(uint256 seed) external {
        address claimant = vm.addr((seed % 1_000_000) + 100);

        if (manager.claimedWallet(campaignId, claimant)) {
            return;
        }

        (,,, uint96 rewardPerCompletion,,, uint64 startTime, uint64 endTime, uint64 closedAt,) =
            manager.campaigns(campaignId);

        uint64 issuedAt = uint64(block.timestamp);
        uint64 issuanceDeadline = closedAt == 0 ? endTime : closedAt;

        if (issuedAt < startTime || issuedAt > issuanceDeadline) {
            return;
        }

        CampaignManager.ClaimAuthorization memory authorization = CampaignManager.ClaimAuthorization({
            campaignId: campaignId,
            claimant: claimant,
            amount: rewardPerCompletion,
            nonce: keccak256(abi.encode(seed, claimant, totalClaimed)),
            issuedAt: issuedAt,
            expiresAt: issuedAt + 5 minutes
        });

        bytes32 digest = manager.hashClaimAuthorization(authorization);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(signerKey, digest);
        bytes memory signature = abi.encodePacked(r, s, v);

        vm.prank(claimant);
        try manager.claim(authorization, signature) {
            totalClaimed += rewardPerCompletion;
        } catch {}
    }

    function close() external {
        (,,,,,,, uint64 endTime,, CampaignManager.CampaignStatus status) = manager.campaigns(campaignId);

        if (status != CampaignManager.CampaignStatus.Active || block.timestamp >= endTime) {
            return;
        }

        vm.prank(advertiser);
        try manager.closeCampaign(campaignId) {} catch {}
    }

    function refund() external {
        vm.prank(advertiser);
        try manager.refundUnusedBudget(campaignId) {} catch {}
    }

    function advanceTime(uint256 seed) external {
        vm.warp(block.timestamp + (seed % 10 minutes) + 1);
    }
}

contract CampaignManagerInvariantTest {
    InvariantVm private constant vm = InvariantVm(address(uint160(uint256(keccak256("hevm cheat code")))));

    uint256 private constant SIGNER_KEY = 0xA11CE;
    uint256 private constant ONE_USDC = 1_000_000;
    uint32 private constant MAX_COMPLETIONS = 10;
    uint256 private constant FUNDED_BUDGET = ONE_USDC * MAX_COMPLETIONS;

    InvariantUSDC private token;
    CampaignManager private manager;
    CampaignInvariantHandler private handler;

    address private advertiser;

    uint256 private campaignId;
    address[] private targetedContracts;

    function setUp() public {
        advertiser = address(this);
        address signer = vm.addr(SIGNER_KEY);

        token = new InvariantUSDC();
        manager = new CampaignManager(address(token), signer);

        uint64 startTime = uint64(block.timestamp + 1);
        uint64 endTime = startTime + 1 hours;

        token.mint(advertiser, FUNDED_BUDGET);

        campaignId = manager.createCampaign(uint96(ONE_USDC), MAX_COMPLETIONS, startTime, endTime);
        token.approve(address(manager), FUNDED_BUDGET);
        manager.fundCampaign(campaignId, FUNDED_BUDGET);

        vm.warp(startTime);

        handler = new CampaignInvariantHandler(manager, token, campaignId, SIGNER_KEY, advertiser);

        targetedContracts.push(address(handler));
    }

    function targetContracts() public view returns (address[] memory) {
        return targetedContracts;
    }

    function invariant_BudgetIsConserved() public view {
        uint256 observedValue = token.balanceOf(address(manager)) + token.balanceOf(advertiser) + handler.totalClaimed();

        require(observedValue == FUNDED_BUDGET, "budget conservation");
    }

    function invariant_PaidRewardsNeverExceedFunding() public view {
        (, uint128 fundedBudget, uint128 paidRewards,,,,,,,) = manager.campaigns(campaignId);

        require(paidRewards <= fundedBudget, "paid > funded");
        require(paidRewards == handler.totalClaimed(), "paid mismatch");
    }

    function invariant_CompletionsStayWithinCap() public view {
        (,,,, uint32 maxCompletions, uint32 paidCompletions,,,,) = manager.campaigns(campaignId);

        require(paidCompletions <= maxCompletions, "completion cap");
    }
}
