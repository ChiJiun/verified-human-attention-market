ALTER TABLE "submissions" ADD COLUMN "claim_onchain_campaign_id" numeric(78, 0);--> statement-breakpoint
-- ADR-0011: authorizations issued so far were signed for the id their campaign
-- is linked to on the same deployment. Rows that cannot be matched stay NULL and
-- are reissued on the next request (the stored signature is then unredeemable).
UPDATE "submissions" s SET "claim_onchain_campaign_id" = c."onchain_campaign_id"
FROM "campaigns" c
WHERE c."id" = s."campaign_id"
  AND s."claim_nonce" IS NOT NULL
  AND c."onchain_campaign_id" IS NOT NULL
  AND c."onchain_contract_address" = s."claim_contract_address"
  AND c."chain_id" = s."claim_chain_id";
