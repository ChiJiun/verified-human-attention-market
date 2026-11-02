CREATE TABLE "indexer_halts" (
	"chain_id" bigint NOT NULL,
	"contract_address" text NOT NULL,
	"halted_block" bigint NOT NULL,
	"halted_at" timestamp with time zone NOT NULL,
	"recovery_applied_at" timestamp with time zone,
	CONSTRAINT "indexer_halts_chain_id_contract_address_pk" PRIMARY KEY("chain_id","contract_address")
);
