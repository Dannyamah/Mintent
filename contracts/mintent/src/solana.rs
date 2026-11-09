//! Strict Solana message parser and the signing policy for card addresses.
//!
//! Why this exists: the MPC network signs whatever bytes the contract forwards, and a Solana signature
//! outlives the NEAR state that authorised it. Without a policy, an owner can obtain a signature, sell the
//! NFT, and broadcast it afterwards; or use a signature to leave a lingering right behind (a Core
//! TransferDelegate plugin, an SPL Approve or SetAuthority, a marketplace listing) that survives the sale.
//!
//! So the contract only signs messages it fully understands, made only of instructions on an allowlist.
//! Anything else fails closed.

use near_sdk::bs58;

pub type Pubkey = [u8; 32];

pub const SYSTEM_PROGRAM: &str = "11111111111111111111111111111111";
pub const COMPUTE_BUDGET_PROGRAM: &str = "ComputeBudget111111111111111111111111111111";
pub const ED25519_PROGRAM: &str = "Ed25519SigVerify111111111111111111111111111";
pub const MEMO_PROGRAM: &str = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr";
pub const ATA_PROGRAM: &str = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
pub const TOKEN_PROGRAM: &str = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
pub const MPL_CORE_PROGRAM: &str = "CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d";
pub const CC_BUYBACK_PROGRAM: &str = "CcBuyM7sDhedBGLZxivBvgZVdqzrQAG66KYHgnTTEpLF";

const ADVANCE_NONCE_DATA: [u8; 4] = [4, 0, 0, 0];
const ATA_CREATE_IDEMPOTENT: u8 = 1;
const SPL_TRANSFER_CHECKED: u8 = 12;
const CORE_TRANSFER_V1: u8 = 14;
const CC_AUTHORIZE_AND_PAY: [u8; 8] = [196, 1, 233, 204, 98, 232, 22, 54];

pub struct Instruction {
    pub program_index: usize,
    pub accounts: Vec<usize>,
    pub data: Vec<u8>,
}

pub struct Message {
    pub keys: Vec<Pubkey>,
    pub instructions: Vec<Instruction>,
}

struct Reader<'a> {
    bytes: &'a [u8],
    pos: usize,
}

impl<'a> Reader<'a> {
    fn u8(&mut self) -> Result<u8, &'static str> {
        let b = *self.bytes.get(self.pos).ok_or("message truncated")?;
        self.pos += 1;
        Ok(b)
    }

    fn take(&mut self, n: usize) -> Result<&'a [u8], &'static str> {
        let end = self.pos.checked_add(n).ok_or("message truncated")?;
        let s = self.bytes.get(self.pos..end).ok_or("message truncated")?;
        self.pos = end;
        Ok(s)
    }

    /// Solana short-vec (compact-u16). Rejects non-canonical encodings so one byte string has one meaning.
    fn compact_u16(&mut self) -> Result<usize, &'static str> {
        let mut value: usize = 0;
        for i in 0..3 {
            let b = self.u8()? as usize;
            value |= (b & 0x7f) << (7 * i);
            if b & 0x80 == 0 {
                if b == 0 && i > 0 {
                    return Err("non-canonical compact-u16");
                }
                return if value <= u16::MAX as usize { Ok(value) } else { Err("compact-u16 overflow") };
            }
        }
        Err("compact-u16 too long")
    }
}

/// Parse a legacy or v0 message. v0 messages with address lookup tables are rejected: the contract must be
/// able to see every account a transaction touches.
pub fn parse_message(bytes: &[u8]) -> Result<Message, &'static str> {
    let mut r = Reader { bytes, pos: 0 };
    let first = r.u8()?;
    let is_v0 = first & 0x80 != 0;
    if is_v0 {
        if first != 0x80 {
            return Err("unsupported message version");
        }
        r.u8()?; // num_required_signatures
    }
    r.take(2)?; // readonly signed / unsigned counts

    let key_count = r.compact_u16()?;
    let mut keys = Vec::with_capacity(key_count);
    for _ in 0..key_count {
        let k: Pubkey = r.take(32)?.try_into().map_err(|_| "bad key")?;
        keys.push(k);
    }
    r.take(32)?; // recent blockhash or durable nonce value

    let ix_count = r.compact_u16()?;
    let mut instructions = Vec::with_capacity(ix_count);
    for _ in 0..ix_count {
        let program_index = r.u8()? as usize;
        if program_index >= key_count {
            return Err("program index out of range");
        }
        let n = r.compact_u16()?;
        let accounts: Vec<usize> = r.take(n)?.iter().map(|b| *b as usize).collect();
        if accounts.iter().any(|a| *a >= key_count) {
            return Err("account index out of range");
        }
        let d = r.compact_u16()?;
        let data = r.take(d)?.to_vec();
        instructions.push(Instruction { program_index, accounts, data });
    }

    if is_v0 && r.compact_u16()? != 0 {
        return Err("address lookup tables are not allowed");
    }
    if r.pos != bytes.len() {
        return Err("trailing bytes after message");
    }
    if instructions.is_empty() {
        return Err("message has no instructions");
    }
    Ok(Message { keys, instructions })
}

#[derive(Debug, PartialEq, Clone, Copy)]
pub struct Classified {
    /// The message moves a Core asset out of the card address.
    pub moves_card: bool,
    /// The message uses a durable nonce (allowed only on Mintent's nonce accounts).
    pub uses_durable_nonce: bool,
}

fn decode(s: &str) -> Pubkey {
    let v = bs58::decode(s).into_vec().expect("valid base58 constant");
    v.try_into().expect("32-byte key")
}

/// Decode a base58 address to a key. Used for owner-configured allowlists.
pub fn decode_pubkey(s: &str) -> Result<Pubkey, &'static str> {
    let v = bs58::decode(s).into_vec().map_err(|_| "invalid base58")?;
    v.try_into().map_err(|_| "address must be 32 bytes")
}

/// Allowlist for card-address signatures. Fails closed on anything not listed here.
pub fn classify_card_message(msg: &Message, allowed_nonces: &[Pubkey], allowed_mints: &[Pubkey]) -> Result<Classified, &'static str> {
    let (system, budget, ed25519, memo, ata, token, core, buyback) = (
        decode(SYSTEM_PROGRAM),
        decode(COMPUTE_BUDGET_PROGRAM),
        decode(ED25519_PROGRAM),
        decode(MEMO_PROGRAM),
        decode(ATA_PROGRAM),
        decode(TOKEN_PROGRAM),
        decode(MPL_CORE_PROGRAM),
        decode(CC_BUYBACK_PROGRAM),
    );
    let mut out = Classified { moves_card: false, uses_durable_nonce: false };

    for (i, ix) in msg.instructions.iter().enumerate() {
        let program = msg.keys[ix.program_index];
        if program == budget || program == ed25519 || program == memo {
            continue;
        } else if program == system {
            // The only System instruction allowed is AdvanceNonce, first, on a Mintent nonce account.
            // That account's authority is the treasury, so the transaction also needs the relayer's signature.
            if i != 0 || ix.data.as_slice() != ADVANCE_NONCE_DATA {
                return Err("system instruction not allowed");
            }
            let nonce = ix.accounts.first().map(|a| msg.keys[*a]).ok_or("nonce account missing")?;
            if !allowed_nonces.contains(&nonce) {
                return Err("durable nonce account not allowed");
            }
            out.uses_durable_nonce = true;
        } else if program == ata {
            if ix.data.as_slice() != [ATA_CREATE_IDEMPOTENT] {
                return Err("only idempotent ATA creation is allowed");
            }
        } else if program == token {
            // Only moving a payment token. No Approve, SetAuthority, CloseAccount or card-mint transfers.
            if ix.data.first() != Some(&SPL_TRANSFER_CHECKED) {
                return Err("only SPL TransferChecked is allowed");
            }
            let mint = ix.accounts.get(1).map(|a| msg.keys[*a]).ok_or("mint account missing")?;
            if !allowed_mints.contains(&mint) {
                return Err("token mint not allowed");
            }
        } else if program == core {
            // Only a plain transfer. No plugin instructions, so no delegate can outlive the owner.
            if ix.data.first() != Some(&CORE_TRANSFER_V1) {
                return Err("only Core TransferV1 is allowed");
            }
            out.moves_card = true;
        } else if program == buyback {
            if ix.data.get(..8) != Some(&CC_AUTHORIZE_AND_PAY[..]) {
                return Err("only cc_buyback authorize_and_pay is allowed");
            }
        } else {
            return Err("program not allowed");
        }
    }
    Ok(out)
}

/// What a keeper may sign: a Collector Crypt sell-back of exactly this card, paid into the card's own address, and nothing else.
/// Returns the price. The contract doesn't know the card's Solana address, and doesn't need to: only the asset's owner can
/// authorise its Core transfer, so the transfer's authority is the card's address whenever the transaction can land. Everything
/// else must point at that same account. Collector Crypt's program then rejects a changed price, quote or destination.
pub fn check_keeper_sellback(msg: &Message, asset: &Pubkey, allowed_mints: &[Pubkey]) -> Result<u64, &'static str> {
    let (system, budget, ed25519, ata, core, buyback) = (
        decode(SYSTEM_PROGRAM),
        decode(COMPUTE_BUDGET_PROGRAM),
        decode(ED25519_PROGRAM),
        decode(ATA_PROGRAM),
        decode(MPL_CORE_PROGRAM),
        decode(CC_BUYBACK_PROGRAM),
    );
    let (mut create, mut transfer, mut pay) = (None, None, None);
    for (i, ix) in msg.instructions.iter().enumerate() {
        let program = msg.keys[ix.program_index];
        let slot = if program == budget || program == ed25519 || (program == system && i == 0) {
            continue;
        } else if program == ata {
            &mut create
        } else if program == core {
            &mut transfer
        } else if program == buyback {
            &mut pay
        } else {
            return Err("a keeper may only sign a sell-back");
        };
        if slot.replace(ix).is_some() {
            return Err("a keeper's sell-back has one step of each kind");
        }
    }
    let pay = pay.ok_or("a keeper may only sign a sell-back to Collector Crypt")?;
    let transfer = transfer.ok_or("no card transfer")?;
    let create = create.ok_or("no token account for the proceeds")?;
    let key = |ix: &Instruction, n: usize| ix.accounts.get(n).map(|a| msg.keys[*a]).ok_or("instruction is missing accounts");

    if key(transfer, 0)? != *asset || key(pay, 2)? != *asset {
        return Err("it sells a different card");
    }
    let holder = key(transfer, 3)?;
    if key(pay, 1)? != holder {
        return Err("the seller isn't the card's holder");
    }
    if key(pay, 3)? != key(transfer, 4)? {
        return Err("the card and the payment name different destinations");
    }
    if key(create, 2)? != holder || key(pay, 5)? != key(create, 1)? {
        return Err("the money doesn't go to the card's own address");
    }
    let mint = key(create, 3)?;
    if !allowed_mints.contains(&mint) || key(pay, 6)? != mint {
        return Err("it pays in a coin that isn't allowed");
    }
    let price = pay.data.get(8..16).ok_or("the payment has no price")?;
    Ok(u64::from_le_bytes(price.try_into().map_err(|_| "the payment has no price")?))
}

/// What a keeper's payout may be: the NFT's USDC split into exactly two transfers, the owner's share to `payout` and a fee to
/// `treasury`, each into a token account the message creates for that owner, and nothing else. Returns (owner's share, fee).
/// Both transfers must come from the same authority, which can only be the card's address: nothing else can sign for its USDC.
pub fn check_keeper_payout(msg: &Message, payout: &Pubkey, treasury: &Pubkey, allowed_mints: &[Pubkey]) -> Result<(u64, u64), &'static str> {
    let (system, budget, ata, token) = (decode(SYSTEM_PROGRAM), decode(COMPUTE_BUDGET_PROGRAM), decode(ATA_PROGRAM), decode(TOKEN_PROGRAM));
    let mut creates = Vec::new();
    let mut transfers = Vec::new();
    for (i, ix) in msg.instructions.iter().enumerate() {
        let program = msg.keys[ix.program_index];
        if program == budget || (program == system && i == 0) {
            continue;
        } else if program == ata {
            creates.push(ix);
        } else if program == token && ix.data.first() == Some(&SPL_TRANSFER_CHECKED) {
            transfers.push(ix);
        } else {
            return Err("a keeper may only pay out to the owner's address");
        }
    }
    if transfers.len() != 2 || creates.len() > 2 {
        return Err("a payout is one transfer to the owner and one fee");
    }
    let key = |ix: &Instruction, n: usize| ix.accounts.get(n).map(|a| msg.keys[*a]).ok_or("instruction is missing accounts");
    let amount = |ix: &Instruction| -> Result<u64, &'static str> {
        let b = ix.data.get(1..9).ok_or("transfer has no amount")?;
        Ok(u64::from_le_bytes(b.try_into().map_err(|_| "transfer has no amount")?))
    };
    // Which owner each destination belongs to, by the token account the message creates for it.
    let owner_of = |dest: Pubkey, mint: Pubkey| -> Result<Pubkey, &'static str> {
        for c in &creates {
            if key(c, 1)? == dest && key(c, 3)? == mint {
                return key(c, 2);
            }
        }
        Err("a transfer goes to an account the message doesn't create")
    };
    let mint = key(transfers[0], 1)?;
    if !allowed_mints.contains(&mint) || key(transfers[1], 1)? != mint {
        return Err("it pays in a coin that isn't allowed");
    }
    if key(transfers[0], 3)? != key(transfers[1], 3)? {
        return Err("the two transfers come from different accounts");
    }
    let (mut net, mut fee) = (None, None);
    for t in &transfers {
        let owner = owner_of(key(t, 2)?, mint)?;
        if owner == *payout && net.is_none() {
            net = Some(amount(t)?);
        } else if owner == *treasury && fee.is_none() {
            fee = Some(amount(t)?);
        } else {
            return Err("the money goes to an address the owner didn't choose");
        }
    }
    Ok((net.ok_or("nothing goes to the owner")?, fee.ok_or("no fee")?))
}

