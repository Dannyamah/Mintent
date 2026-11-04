//! TEST ONLY. Stand-in for the NEAR MPC signer (`v1.signer`) so the sandbox tests can run.
//! Same `sign` entry point; records who asked for which path and returns a deterministic
//! fake Ed25519-shaped response. It does NOT produce real signatures.
use near_sdk::serde_json::{json, Value};
use near_sdk::{env, near, require, AccountId, NearToken, PanicOnDefault};

#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct Recorded {
    pub predecessor: AccountId,
    pub path: String,
    pub domain_id: u64,
    pub payload_hex: String,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct MockSigner {
    requests: Vec<Recorded>,
}

#[near]
impl MockSigner {
    #[init]
    pub fn new() -> Self {
        Self { requests: Vec::new() }
    }

    #[payable]
    pub fn sign(&mut self, request: Value) -> Value {
        require!(env::attached_deposit() >= NearToken::from_yoctonear(1), "deposit of 1 yoctoNEAR required");
        let payload_hex = request["payload_v2"]["Eddsa"].as_str().unwrap_or_default().to_string();
        let path = request["path"].as_str().unwrap_or_default().to_string();
        let domain_id = request["domain_id"].as_u64().unwrap_or(u64::MAX);
        self.requests.push(Recorded { predecessor: env::predecessor_account_id(), path: path.clone(), domain_id, payload_hex });
        // Deterministic fake: sha256(predecessor|path) repeated to 64 bytes.
        let h = env::sha256(format!("{}|{}", env::predecessor_account_id(), path).as_bytes());
        let sig: Vec<u8> = h.iter().chain(h.iter()).copied().collect();
        json!({ "scheme": "Ed25519", "signature": sig })
    }

    pub fn get_requests(&self) -> Vec<Recorded> {
        self.requests.clone()
    }
}
