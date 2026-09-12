//! THE LOCK CLIENT'S DATABASE, KEPT IN THE TAB (W1b).
//!
//! The stock client's state lived in a MemDatabase, so a reload between the
//! player's deposit and the lock lost the wallet - measured on regtest, the
//! committed page asked for the deposit again (994270 msat, then 994270 msat).
//! Fedimint's own recovery cannot run here: mintv2's recovery-slice fetch is
//! bounded by tokio's clock, and `std::time::Instant::now` panics on
//! wasm32-unknown-unknown (measured: "sys/time/unsupported.rs"). The stock
//! persistent database (cursed-redb) needs an OPFS sync handle, which only a
//! worker has. So this is MemDatabase's own semantics - reads from a copy,
//! write conflicts refused at commit - with every committed key written
//! through to the tab's storage and read back when the page loads again. No
//! consensus code and no crypto: bytes under keys.
use std::fmt;
use std::ops::Range;
use std::path::Path;
use std::sync::RwLock;

use fedimint_core::async_trait_maybe_send;
use fedimint_core::db::{
    DatabaseError, DatabaseResult, IDatabaseTransactionOps, IDatabaseTransactionOpsCore, IRawDatabase,
    IRawDatabaseTransaction, PrefixStream,
};
use futures::{StreamExt, stream};
use imbl::OrdMap;
use macro_rules_attribute::apply;
use wasm_bindgen::prelude::*;

#[wasm_bindgen]
extern "C" {
    /// Where the tab keeps it: `entries()` is JSON `[[keyHex, valueHex], ...]`,
    /// `put` and `remove` one key. The page scopes it to one round and one seed.
    pub type LockStore;
    #[wasm_bindgen(method, catch)]
    fn entries(this: &LockStore) -> Result<String, JsValue>;
    #[wasm_bindgen(method, catch)]
    fn put(this: &LockStore, key: &str, value: &str) -> Result<(), JsValue>;
    #[wasm_bindgen(method, catch)]
    fn remove(this: &LockStore, key: &str) -> Result<(), JsValue>;
}

fn to_hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

fn from_hex(s: &str) -> Option<Vec<u8>> {
    if s.len() % 2 != 0 {
        return None;
    }
    (0..s.len()).step_by(2).map(|i| u8::from_str_radix(s.get(i..i + 2)?, 16).ok()).collect()
}

fn store_error(what: &str, e: &JsValue) -> DatabaseError {
    DatabaseError::Other(anyhow::anyhow!("the tab's storage would not {what}: {e:?}"))
}

pub struct TabDatabase {
    data: RwLock<OrdMap<Vec<u8>, Vec<u8>>>,
    store: LockStore,
}

impl fmt::Debug for TabDatabase {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("TabDatabase")
    }
}

impl TabDatabase {
    /// The wallet the tab kept, or an empty one; and how many keys it held.
    pub fn load(store: LockStore) -> anyhow::Result<(Self, usize)> {
        let raw = store.entries().map_err(|e| anyhow::anyhow!("the tab's storage could not be read: {e:?}"))?;
        let pairs: Vec<(String, String)> = serde_json::from_str(&raw)?;
        let mut data = OrdMap::new();
        for (k, v) in &pairs {
            let (Some(k), Some(v)) = (from_hex(k), from_hex(v)) else {
                anyhow::bail!("the tab's storage holds a key or value that is not hex");
            };
            data.insert(k, v);
        }
        Ok((Self { data: RwLock::new(data), store }, pairs.len()))
    }
}

enum Op {
    Insert { key: Vec<u8>, value: Vec<u8>, old: Option<Vec<u8>> },
    Delete { key: Vec<u8>, old: Option<Vec<u8>> },
}

pub struct TabTransaction<'a> {
    operations: Vec<Op>,
    tx_data: OrdMap<Vec<u8>, Vec<u8>>,
    db: &'a TabDatabase,
}

impl fmt::Debug for TabTransaction<'_> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "TabTransaction {{ operations={} }}", self.operations.len())
    }
}

#[apply(async_trait_maybe_send!)]
impl IRawDatabase for TabDatabase {
    type Transaction<'a> = TabTransaction<'a>;
    async fn begin_transaction<'a>(&'a self) -> TabTransaction<'a> {
        TabTransaction { operations: Vec::new(), tx_data: self.data.read().expect("poisoned").clone(), db: self }
    }

    fn checkpoint(&self, _backup_path: &Path) -> DatabaseResult<()> {
        Ok(())
    }
}

#[apply(async_trait_maybe_send!)]
impl IDatabaseTransactionOpsCore for TabTransaction<'_> {
    async fn raw_insert_bytes(&mut self, key: &[u8], value: &[u8]) -> DatabaseResult<Option<Vec<u8>>> {
        let old = self.tx_data.insert(key.to_vec(), value.to_owned());
        self.operations.push(Op::Insert { key: key.to_vec(), value: value.to_owned(), old: old.clone() });
        Ok(old)
    }

    async fn raw_get_bytes(&mut self, key: &[u8]) -> DatabaseResult<Option<Vec<u8>>> {
        Ok(self.tx_data.get(key).cloned())
    }

    async fn raw_remove_entry(&mut self, key: &[u8]) -> DatabaseResult<Option<Vec<u8>>> {
        let old = self.tx_data.remove(&key.to_vec());
        self.operations.push(Op::Delete { key: key.to_vec(), old: old.clone() });
        Ok(old)
    }

    async fn raw_remove_by_prefix(&mut self, key_prefix: &[u8]) -> DatabaseResult<()> {
        let keys = self.raw_find_by_prefix(key_prefix).await?.map(|kv| kv.0).collect::<Vec<_>>().await;
        for key in keys {
            self.raw_remove_entry(key.as_slice()).await?;
        }
        Ok(())
    }

    async fn raw_find_by_prefix(&mut self, key_prefix: &[u8]) -> DatabaseResult<PrefixStream<'_>> {
        let data = self
            .tx_data
            .range((key_prefix.to_vec())..)
            .take_while(|(key, _)| key.starts_with(key_prefix))
            .map(|(key, value)| (key.clone(), value.clone()))
            .collect::<Vec<_>>();
        Ok(Box::pin(stream::iter(data)))
    }

    async fn raw_find_by_prefix_sorted_descending(&mut self, key_prefix: &[u8]) -> DatabaseResult<PrefixStream<'_>> {
        let mut data = self
            .tx_data
            .range((key_prefix.to_vec())..)
            .take_while(|(key, _)| key.starts_with(key_prefix))
            .map(|(key, value)| (key.clone(), value.clone()))
            .collect::<Vec<_>>();
        data.sort_by(|a, b| a.cmp(b).reverse());
        Ok(Box::pin(stream::iter(data)))
    }

    async fn raw_find_by_range(&mut self, range: Range<&[u8]>) -> DatabaseResult<PrefixStream<'_>> {
        let data = self
            .tx_data
            .range(Range { start: range.start.to_vec(), end: range.end.to_vec() })
            .map(|(key, value)| (key.clone(), value.clone()))
            .collect::<Vec<_>>();
        Ok(Box::pin(stream::iter(data)))
    }
}

impl IDatabaseTransactionOps for TabTransaction<'_> {}

#[apply(async_trait_maybe_send!)]
impl IRawDatabaseTransaction for TabTransaction<'_> {
    async fn commit_tx(self) -> DatabaseResult<()> {
        let mut data = self.db.data.write().expect("poisoned");
        let mut copy = data.clone();
        for op in &self.operations {
            let conflict = match op {
                Op::Insert { key, value, old } => copy.insert(key.clone(), value.clone()) != *old,
                Op::Delete { key, old } => copy.remove(key) != *old,
            };
            if conflict {
                return Err(DatabaseError::WriteConflict);
            }
        }
        // WRITTEN THROUGH BEFORE IT COUNTS: a key the tab could not keep is a
        // commit that did not happen, and the client is told so.
        for op in &self.operations {
            match op {
                Op::Insert { key, value, .. } => {
                    self.db.store.put(&to_hex(key), &to_hex(value)).map_err(|e| store_error("keep a key", &e))?;
                }
                Op::Delete { key, .. } => {
                    self.db.store.remove(&to_hex(key)).map_err(|e| store_error("drop a key", &e))?;
                }
            }
        }
        *data = copy;
        Ok(())
    }
}
