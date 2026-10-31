let wasm;

function addToExternrefTable0(obj) {
    const idx = wasm.__externref_table_alloc();
    wasm.__wbindgen_externrefs.set(idx, obj);
    return idx;
}

const CLOSURE_DTORS = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(state => state.dtor(state.a, state.b));

function debugString(val) {
    // primitive types
    const type = typeof val;
    if (type == 'number' || type == 'boolean' || val == null) {
        return  `${val}`;
    }
    if (type == 'string') {
        return `"${val}"`;
    }
    if (type == 'symbol') {
        const description = val.description;
        if (description == null) {
            return 'Symbol';
        } else {
            return `Symbol(${description})`;
        }
    }
    if (type == 'function') {
        const name = val.name;
        if (typeof name == 'string' && name.length > 0) {
            return `Function(${name})`;
        } else {
            return 'Function';
        }
    }
    // objects
    if (Array.isArray(val)) {
        const length = val.length;
        let debug = '[';
        if (length > 0) {
            debug += debugString(val[0]);
        }
        for(let i = 1; i < length; i++) {
            debug += ', ' + debugString(val[i]);
        }
        debug += ']';
        return debug;
    }
    // Test for built-in
    const builtInMatches = /\[object ([^\]]+)\]/.exec(toString.call(val));
    let className;
    if (builtInMatches && builtInMatches.length > 1) {
        className = builtInMatches[1];
    } else {
        // Failed to match the standard '[object ClassName]'
        return toString.call(val);
    }
    if (className == 'Object') {
        // we're a user defined class or Object
        // JSON.stringify avoids problems with cycles, and is generally much
        // easier than looping through ownProperties of `val`.
        try {
            return 'Object(' + JSON.stringify(val) + ')';
        } catch (_) {
            return 'Object';
        }
    }
    // errors
    if (val instanceof Error) {
        return `${val.name}: ${val.message}\n${val.stack}`;
    }
    // TODO we could test for more things here, like `Set`s and `Map`s.
    return className;
}

function getArrayU8FromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return getUint8ArrayMemory0().subarray(ptr / 1, ptr / 1 + len);
}

let cachedDataViewMemory0 = null;
function getDataViewMemory0() {
    if (cachedDataViewMemory0 === null || cachedDataViewMemory0.buffer.detached === true || (cachedDataViewMemory0.buffer.detached === undefined && cachedDataViewMemory0.buffer !== wasm.memory.buffer)) {
        cachedDataViewMemory0 = new DataView(wasm.memory.buffer);
    }
    return cachedDataViewMemory0;
}

function getStringFromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return decodeText(ptr, len);
}

let cachedUint8ArrayMemory0 = null;
function getUint8ArrayMemory0() {
    if (cachedUint8ArrayMemory0 === null || cachedUint8ArrayMemory0.byteLength === 0) {
        cachedUint8ArrayMemory0 = new Uint8Array(wasm.memory.buffer);
    }
    return cachedUint8ArrayMemory0;
}

function handleError(f, args) {
    try {
        return f.apply(this, args);
    } catch (e) {
        const idx = addToExternrefTable0(e);
        wasm.__wbindgen_exn_store(idx);
    }
}

function isLikeNone(x) {
    return x === undefined || x === null;
}

function makeClosure(arg0, arg1, dtor, f) {
    const state = { a: arg0, b: arg1, cnt: 1, dtor };
    const real = (...args) => {

        // First up with a closure we increment the internal reference
        // count. This ensures that the Rust closure environment won't
        // be deallocated while we're invoking it.
        state.cnt++;
        try {
            return f(state.a, state.b, ...args);
        } finally {
            real._wbg_cb_unref();
        }
    };
    real._wbg_cb_unref = () => {
        if (--state.cnt === 0) {
            state.dtor(state.a, state.b);
            state.a = 0;
            CLOSURE_DTORS.unregister(state);
        }
    };
    CLOSURE_DTORS.register(real, state, state);
    return real;
}

function makeMutClosure(arg0, arg1, dtor, f) {
    const state = { a: arg0, b: arg1, cnt: 1, dtor };
    const real = (...args) => {

        // First up with a closure we increment the internal reference
        // count. This ensures that the Rust closure environment won't
        // be deallocated while we're invoking it.
        state.cnt++;
        const a = state.a;
        state.a = 0;
        try {
            return f(a, state.b, ...args);
        } finally {
            state.a = a;
            real._wbg_cb_unref();
        }
    };
    real._wbg_cb_unref = () => {
        if (--state.cnt === 0) {
            state.dtor(state.a, state.b);
            state.a = 0;
            CLOSURE_DTORS.unregister(state);
        }
    };
    CLOSURE_DTORS.register(real, state, state);
    return real;
}

function passStringToWasm0(arg, malloc, realloc) {
    if (realloc === undefined) {
        const buf = cachedTextEncoder.encode(arg);
        const ptr = malloc(buf.length, 1) >>> 0;
        getUint8ArrayMemory0().subarray(ptr, ptr + buf.length).set(buf);
        WASM_VECTOR_LEN = buf.length;
        return ptr;
    }

    let len = arg.length;
    let ptr = malloc(len, 1) >>> 0;

    const mem = getUint8ArrayMemory0();

    let offset = 0;

    for (; offset < len; offset++) {
        const code = arg.charCodeAt(offset);
        if (code > 0x7F) break;
        mem[ptr + offset] = code;
    }
    if (offset !== len) {
        if (offset !== 0) {
            arg = arg.slice(offset);
        }
        ptr = realloc(ptr, len, len = offset + arg.length * 3, 1) >>> 0;
        const view = getUint8ArrayMemory0().subarray(ptr + offset, ptr + len);
        const ret = cachedTextEncoder.encodeInto(arg, view);

        offset += ret.written;
        ptr = realloc(ptr, len, offset, 1) >>> 0;
    }

    WASM_VECTOR_LEN = offset;
    return ptr;
}

function takeFromExternrefTable0(idx) {
    const value = wasm.__wbindgen_externrefs.get(idx);
    wasm.__externref_table_dealloc(idx);
    return value;
}

let cachedTextDecoder = new TextDecoder('utf-8', { ignoreBOM: true, fatal: true });
cachedTextDecoder.decode();
const MAX_SAFARI_DECODE_BYTES = 2146435072;
let numBytesDecoded = 0;
function decodeText(ptr, len) {
    numBytesDecoded += len;
    if (numBytesDecoded >= MAX_SAFARI_DECODE_BYTES) {
        cachedTextDecoder = new TextDecoder('utf-8', { ignoreBOM: true, fatal: true });
        cachedTextDecoder.decode();
        numBytesDecoded = len;
    }
    return cachedTextDecoder.decode(getUint8ArrayMemory0().subarray(ptr, ptr + len));
}

const cachedTextEncoder = new TextEncoder();

if (!('encodeInto' in cachedTextEncoder)) {
    cachedTextEncoder.encodeInto = function (arg, view) {
        const buf = cachedTextEncoder.encode(arg);
        view.set(buf);
        return {
            read: arg.length,
            written: buf.length
        };
    }
}

let WASM_VECTOR_LEN = 0;

function wasm_bindgen_a3ba67b85167eb47___convert__closures_____invoke_______6_(arg0, arg1) {
    wasm.wasm_bindgen_a3ba67b85167eb47___convert__closures_____invoke_______6_(arg0, arg1);
}

function wasm_bindgen_a3ba67b85167eb47___convert__closures_____invoke___web_sys_9de5fc31cbd76c75___features__gen_CloseEvent__CloseEvent______1_(arg0, arg1, arg2) {
    wasm.wasm_bindgen_a3ba67b85167eb47___convert__closures_____invoke___web_sys_9de5fc31cbd76c75___features__gen_CloseEvent__CloseEvent______1_(arg0, arg1, arg2);
}

function wasm_bindgen_a3ba67b85167eb47___convert__closures_____invoke___wasm_bindgen_a3ba67b85167eb47___JsValue_____(arg0, arg1, arg2) {
    wasm.wasm_bindgen_a3ba67b85167eb47___convert__closures_____invoke___wasm_bindgen_a3ba67b85167eb47___JsValue_____(arg0, arg1, arg2);
}

function wasm_bindgen_a3ba67b85167eb47___convert__closures_____invoke_______5_(arg0, arg1) {
    wasm.wasm_bindgen_a3ba67b85167eb47___convert__closures_____invoke_______5_(arg0, arg1);
}

function wasm_bindgen_a3ba67b85167eb47___convert__closures_____invoke_______3_(arg0, arg1) {
    wasm.wasm_bindgen_a3ba67b85167eb47___convert__closures_____invoke_______3_(arg0, arg1);
}

function wasm_bindgen_a3ba67b85167eb47___convert__closures_____invoke___web_sys_9de5fc31cbd76c75___features__gen_CloseEvent__CloseEvent_____(arg0, arg1, arg2) {
    wasm.wasm_bindgen_a3ba67b85167eb47___convert__closures_____invoke___web_sys_9de5fc31cbd76c75___features__gen_CloseEvent__CloseEvent_____(arg0, arg1, arg2);
}

function wasm_bindgen_a3ba67b85167eb47___convert__closures_____invoke______(arg0, arg1) {
    wasm.wasm_bindgen_a3ba67b85167eb47___convert__closures_____invoke______(arg0, arg1);
}

function wasm_bindgen_a3ba67b85167eb47___convert__closures_____invoke_______4_(arg0, arg1) {
    wasm.wasm_bindgen_a3ba67b85167eb47___convert__closures_____invoke_______4_(arg0, arg1);
}

function wasm_bindgen_a3ba67b85167eb47___convert__closures_____invoke_______7_(arg0, arg1) {
    wasm.wasm_bindgen_a3ba67b85167eb47___convert__closures_____invoke_______7_(arg0, arg1);
}

function wasm_bindgen_a3ba67b85167eb47___convert__closures_____invoke_______1_(arg0, arg1) {
    wasm.wasm_bindgen_a3ba67b85167eb47___convert__closures_____invoke_______1_(arg0, arg1);
}

function wasm_bindgen_a3ba67b85167eb47___convert__closures_____invoke___web_sys_9de5fc31cbd76c75___features__gen_MessageEvent__MessageEvent_____(arg0, arg1, arg2) {
    wasm.wasm_bindgen_a3ba67b85167eb47___convert__closures_____invoke___web_sys_9de5fc31cbd76c75___features__gen_MessageEvent__MessageEvent_____(arg0, arg1, arg2);
}

function wasm_bindgen_a3ba67b85167eb47___convert__closures_____invoke_______2_(arg0, arg1) {
    wasm.wasm_bindgen_a3ba67b85167eb47___convert__closures_____invoke_______2_(arg0, arg1);
}

function wasm_bindgen_a3ba67b85167eb47___convert__closures_____invoke_______8_(arg0, arg1) {
    wasm.wasm_bindgen_a3ba67b85167eb47___convert__closures_____invoke_______8_(arg0, arg1);
}

function wasm_bindgen_a3ba67b85167eb47___convert__closures_____invoke___web_sys_9de5fc31cbd76c75___features__gen_CloseEvent__CloseEvent______2_(arg0, arg1, arg2) {
    wasm.wasm_bindgen_a3ba67b85167eb47___convert__closures_____invoke___web_sys_9de5fc31cbd76c75___features__gen_CloseEvent__CloseEvent______2_(arg0, arg1, arg2);
}

function wasm_bindgen_a3ba67b85167eb47___convert__closures_____invoke___wasm_bindgen_a3ba67b85167eb47___JsValue__wasm_bindgen_a3ba67b85167eb47___JsValue_____(arg0, arg1, arg2, arg3) {
    wasm.wasm_bindgen_a3ba67b85167eb47___convert__closures_____invoke___wasm_bindgen_a3ba67b85167eb47___JsValue__wasm_bindgen_a3ba67b85167eb47___JsValue_____(arg0, arg1, arg2, arg3);
}

const __wbindgen_enum_BinaryType = ["blob", "arraybuffer"];

const __wbindgen_enum_ReadableStreamType = ["bytes"];

const __wbindgen_enum_RequestCache = ["default", "no-store", "reload", "no-cache", "force-cache", "only-if-cached"];

const __wbindgen_enum_RequestCredentials = ["omit", "same-origin", "include"];

const __wbindgen_enum_RequestMode = ["same-origin", "no-cors", "cors", "navigate"];

const IntoUnderlyingByteSourceFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_intounderlyingbytesource_free(ptr >>> 0, 1));

const IntoUnderlyingSinkFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_intounderlyingsink_free(ptr >>> 0, 1));

const IntoUnderlyingSourceFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_intounderlyingsource_free(ptr >>> 0, 1));

const LockClientFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_lockclient_free(ptr >>> 0, 1));

export class IntoUnderlyingByteSource {
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        IntoUnderlyingByteSourceFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_intounderlyingbytesource_free(ptr, 0);
    }
    /**
     * @returns {number}
     */
    get autoAllocateChunkSize() {
        const ret = wasm.intounderlyingbytesource_autoAllocateChunkSize(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * @param {ReadableByteStreamController} controller
     * @returns {Promise<any>}
     */
    pull(controller) {
        const ret = wasm.intounderlyingbytesource_pull(this.__wbg_ptr, controller);
        return ret;
    }
    /**
     * @param {ReadableByteStreamController} controller
     */
    start(controller) {
        wasm.intounderlyingbytesource_start(this.__wbg_ptr, controller);
    }
    /**
     * @returns {ReadableStreamType}
     */
    get type() {
        const ret = wasm.intounderlyingbytesource_type(this.__wbg_ptr);
        return __wbindgen_enum_ReadableStreamType[ret];
    }
    cancel() {
        const ptr = this.__destroy_into_raw();
        wasm.intounderlyingbytesource_cancel(ptr);
    }
}
if (Symbol.dispose) IntoUnderlyingByteSource.prototype[Symbol.dispose] = IntoUnderlyingByteSource.prototype.free;

export class IntoUnderlyingSink {
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        IntoUnderlyingSinkFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_intounderlyingsink_free(ptr, 0);
    }
    /**
     * @param {any} reason
     * @returns {Promise<any>}
     */
    abort(reason) {
        const ptr = this.__destroy_into_raw();
        const ret = wasm.intounderlyingsink_abort(ptr, reason);
        return ret;
    }
    /**
     * @returns {Promise<any>}
     */
    close() {
        const ptr = this.__destroy_into_raw();
        const ret = wasm.intounderlyingsink_close(ptr);
        return ret;
    }
    /**
     * @param {any} chunk
     * @returns {Promise<any>}
     */
    write(chunk) {
        const ret = wasm.intounderlyingsink_write(this.__wbg_ptr, chunk);
        return ret;
    }
}
if (Symbol.dispose) IntoUnderlyingSink.prototype[Symbol.dispose] = IntoUnderlyingSink.prototype.free;

export class IntoUnderlyingSource {
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        IntoUnderlyingSourceFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_intounderlyingsource_free(ptr, 0);
    }
    /**
     * @param {ReadableStreamDefaultController} controller
     * @returns {Promise<any>}
     */
    pull(controller) {
        const ret = wasm.intounderlyingsource_pull(this.__wbg_ptr, controller);
        return ret;
    }
    cancel() {
        const ptr = this.__destroy_into_raw();
        wasm.intounderlyingsource_cancel(ptr);
    }
}
if (Symbol.dispose) IntoUnderlyingSource.prototype[Symbol.dispose] = IntoUnderlyingSource.prototype.free;

export class LockClient {
    static __wrap(ptr) {
        ptr = ptr >>> 0;
        const obj = Object.create(LockClient.prototype);
        obj.__wbg_ptr = ptr;
        LockClientFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        LockClientFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_lockclient_free(ptr, 0);
    }
    /**
     * A PAYMENT TO KEYS AND NOTHING ELSE (an in-game item's purchase): one transaction from this wallet's e-cash whose
     * outputs are only pre-expired payout contracts - each `payouts` entry (JSON `[{"pk": 33-byte hex, "msat": "n", "image": 64
     * hex}]`, in the order given) one contract its payee alone can Refund, built exactly as `lockSubmit` builds a donation's. No
     * stake, no fee lock, no block count (a payout's expiration is 0). Answered on submission in `lockSubmit`'s shape (every output
     * of role "payout", block_count_at_lock and expiry_delta 0), so `lockAccepted` awaits and checks it unchanged.
     * @param {string} payouts
     * @returns {Promise<string>}
     */
    paySubmit(payouts) {
        const ptr0 = passStringToWasm0(payouts, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.lockclient_paySubmit(this.__wbg_ptr, ptr0, len0);
        return ret;
    }
    /**
     * AN AMOUNT AS E-CASH (kanban #614, 2026-10-24: "Kein Lightning swap, sondern übertragen in die andere federation"): the stock
     * mint module's send of exactly `amount_msat`, as the prefixed base32 string a seat's exchange takes - the player's side of an e-cash
     * exchange into another federation. Answers {"msat", "ecash"}; the caller keeps the string until the exchange answered.
     * @param {string} amount_msat
     * @returns {Promise<string>}
     */
    sendEcash(amount_msat) {
        const ptr0 = passStringToWasm0(amount_msat, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.lockclient_sendEcash(this.__wbg_ptr, ptr0, len0);
        return ret;
    }
    /**
     * The smallest invoice that credits at least `ecash_msat` of ecash, through
     * a gateway the federation lists: JSON { invoice_msat, credited_msat, gateway }.
     * Both fees are the ones the gateway and the federation publish.
     * @param {string} ecash_msat
     * @returns {Promise<string>}
     */
    depositFor(ecash_msat) {
        const ptr0 = passStringToWasm0(ecash_msat, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.lockclient_depositFor(this.__wbg_ptr, ptr0, len0);
        return ret;
    }
    /**
     * WHERE A LOCK STANDS, asked of the guardians without spending anything (W4 / 6d): the
     * federation's block count and, while the contract is still at that outpoint, its id and
     * the blocks left before its expiration. A page refunding a lock no seat will settle asks
     * this first, so it does not send the guardians a refund they must refuse every few
     * seconds until the expiry block. JSON: { block_count, stored: { contract_id,
     * blocks_left } | null }.
     * @param {string} txid
     * @param {number} out_idx
     * @returns {Promise<string>}
     */
    lockStatus(txid, out_idx) {
        const ptr0 = passStringToWasm0(txid, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.lockclient_lockStatus(this.__wbg_ptr, ptr0, len0, out_idx);
        return ret;
    }
    /**
     * @param {string} point
     * @param {string} stake_msat
     * @param {string} fee_hash
     * @param {string} fee_msat
     * @param {string} claim_pk
     * @param {string} refund_pk
     * @param {number} expiry_delta
     * @param {string} donations
     * @returns {Promise<string>}
     */
    lockSubmit(point, stake_msat, fee_hash, fee_msat, claim_pk, refund_pk, expiry_delta, donations) {
        const ptr0 = passStringToWasm0(point, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(stake_msat, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len1 = WASM_VECTOR_LEN;
        const ptr2 = passStringToWasm0(fee_hash, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len2 = WASM_VECTOR_LEN;
        const ptr3 = passStringToWasm0(fee_msat, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len3 = WASM_VECTOR_LEN;
        const ptr4 = passStringToWasm0(claim_pk, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len4 = WASM_VECTOR_LEN;
        const ptr5 = passStringToWasm0(refund_pk, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len5 = WASM_VECTOR_LEN;
        const ptr6 = passStringToWasm0(donations, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len6 = WASM_VECTOR_LEN;
        const ret = wasm.lockclient_lockSubmit(this.__wbg_ptr, ptr0, len0, ptr1, len1, ptr2, len2, ptr3, len3, ptr4, len4, ptr5, len5, expiry_delta, ptr6, len6);
        return ret;
    }
    /**
     * The client's ecash, in msat, as a decimal string.
     * @returns {Promise<string>}
     */
    balanceMsat() {
        const ret = wasm.lockclient_balanceMsat(this.__wbg_ptr);
        return ret;
    }
    /**
     * THE E-CASH STILL BEING ISSUED to this wallet, in msat, as a decimal string: every pending mintv2 output
     * state machine's denominations - a recovery's re-issue, a deposit's notes, a payment's change. `balanceMsat` counts
     * none of it until its machine finishes; held + issuing is what the wallet will hold.
     * @returns {Promise<string>}
     */
    issuingMsat() {
        const ret = wasm.lockclient_issuingMsat(this.__wbg_ptr);
        return ret;
    }
    /**
     * Until the deposit is final: "Claimed", "Expired" or "Failure".
     * @param {string} operation
     * @returns {Promise<string>}
     */
    awaitReceive(operation) {
        const ptr0 = passStringToWasm0(operation, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.lockclient_awaitReceive(this.__wbg_ptr, ptr0, len0);
        return ret;
    }
    /**
     * AND ITS ACCEPTANCE: the submitted lock (`submitted`, `lockSubmit`'s answer) awaited until the guardians accept it, then
     * every output read where it was built and checked against the contract id computed - answered in `lockWithDonations`'
     * shape ({ stake, fee, donations }), so the page checks it exactly as before. An output the guardians hold elsewhere, or
     * not at all, is an error: the entry named that outpoint.
     * @param {string} submitted
     * @returns {Promise<string>}
     */
    lockAccepted(submitted) {
        const ptr0 = passStringToWasm0(submitted, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.lockclient_lockAccepted(this.__wbg_ptr, ptr0, len0);
        return ret;
    }
    /**
     * E-CASH IN: reissued into this wallet; answers once the federation has reissued it - {"state": "Success" |
     * "Rejected" (already spent) | "AlreadyReceived"}.
     * @param {string} ecash
     * @returns {Promise<string>}
     */
    receiveEcash(ecash) {
        const ptr0 = passStringToWasm0(ecash, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.lockclient_receiveEcash(this.__wbg_ptr, ptr0, len0);
        return ret;
    }
    /**
     * A BATCH OF THE SCAN FOR LOST DEPOSITS (kanban #883), from `start`: JSON { next, done, found: [{ operation, msat }] }. The caller waits on each
     * found operation with awaitReceive; the federation answers at once while there is more, and holds a read at its end, so the page bounds the call.
     * @param {string} start
     * @returns {Promise<string>}
     */
    scanDeposits(start) {
        const ptr0 = passStringToWasm0(start, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.lockclient_scanDeposits(this.__wbg_ptr, ptr0, len0);
        return ret;
    }
    /**
     * What locking `amount_msat` costs this client's ecash: the amount plus the
     * federation's own quote for that transaction (one Lightning output), as a
     * decimal string. Point-in-time: it moves with the notes the client holds.
     * @param {string} amount_msat
     * @returns {Promise<string>}
     */
    lockCostMsat(amount_msat) {
        const ptr0 = passStringToWasm0(amount_msat, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.lockclient_lockCostMsat(this.__wbg_ptr, ptr0, len0);
        return ret;
    }
    /**
     * THE WHOLE BALANCE AS E-CASH (2026-10-02: "Can't we show all wallets we have and combine all of them when
     * playing a round?"): the stock mint module's send of everything this wallet holds, as the prefixed base32 string
     * another wallet of the same federation receives. Answers {"msat", "ecash"}; ecash null when the wallet is empty.
     * The caller keeps the string until it is received - spent here, it exists nowhere else.
     * @returns {Promise<string>}
     */
    sendAllEcash() {
        const ret = wasm.lockclient_sendAllEcash(this.__wbg_ptr);
        return ret;
    }
    /**
     * THE OUTPUTS STILL IN ISSUANCE (spec 23A.5 "Notes still in issuance at the halt"): everything issued to this
     * wallet's seed that it neither holds as a note nor has spent - read from one answering guardian, so it works while the
     * federation is halted. Answers [{"nonce", "amount_msat", "request"}]; `request` is what a pending-output claim presents.
     * @returns {Promise<string>}
     */
    pendingOutputs() {
        const ret = wasm.lockclient_pendingOutputs(this.__wbg_ptr);
        return ret;
    }
    /**
     * THE STAKE LOCK AND THE FEE LOCK IN ONE TRANSACTION (2026-10-02, the join's 2-3 s: "Cut whatever is between the
     * click and the loaded round"). Measured on testnet4 the two locks were two transactions one after the other - each a
     * block count, a submit, the wait for the guardians to accept it, a search of its outputs and a second block count:
     * 'locking the stake' to 'fee lock: minted' 7.2 s in a paid join (Q4, 22:29:17-25Z). Here: one block count, one
     * transaction carrying both outgoing contracts, one acceptance, and both outpoints read together - outputs 0 and 1 as
     * built, any other output only if they are not it. Each contract is matched to its outpoint by the id the guardians
     * store, so the answer is two answers of `lock`'s own shape ("stake", "fee"), checked by the page as before.
     * THE BLOCK COUNT READ AHEAD (the join's 2-3 s): the lobby asks it once its wallet is open, so the lock that follows
     * within a minute builds on it instead of a consensus read of its own. Answers the count.
     * @returns {Promise<string>}
     */
    warmBlockCount() {
        const ret = wasm.lockclient_warmBlockCount(this.__wbg_ptr);
        return ret;
    }
    /**
     * The largest invoice this client can pay out of its balance through a
     * gateway the federation lists - the gateway's fee and the federation's
     * both taken off (the stock client's own sum), in msat.
     * @returns {Promise<string>}
     */
    withdrawableMsat() {
        const ret = wasm.lockclient_withdrawableMsat(this.__wbg_ptr);
        return ret;
    }
    /**
     * THE STAKE, ITS FEE LOCK AND THE PLAYER'S DONATION IN ONE TRANSACTION (2026-10-03, FEDERATION.md "Donations in
     * the federation"): the stake lock and - when `fee_hash` is not empty - the fee lock as `lockBoth` builds them, and one
     * payout contract per entry of `donations` (JSON `[{"pk": 33-byte hex, "msat": "n"}, ...]` in the set's order): the zero
     * hash image, expired from the start, claim, refund and ephemeral key all the recipient's - only that key can spend it,
     * by Refund, at any time (the settlement's payout shape). Every output is matched to its outpoint by the id the guardians
     * store. JSON: { "stake": <lock's shape>, "fee": <lock's shape> | null, "donations": [{ txid, out_idx, recipient_pk,
     * amount_msat, stored_contract_id, ids_match }] }.
     * @param {string} point
     * @param {string} stake_msat
     * @param {string} fee_hash
     * @param {string} fee_msat
     * @param {string} claim_pk
     * @param {string} refund_pk
     * @param {number} expiry_delta
     * @param {string} donations
     * @returns {Promise<string>}
     */
    lockWithDonations(point, stake_msat, fee_hash, fee_msat, claim_pk, refund_pk, expiry_delta, donations) {
        const ptr0 = passStringToWasm0(point, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(stake_msat, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len1 = WASM_VECTOR_LEN;
        const ptr2 = passStringToWasm0(fee_hash, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len2 = WASM_VECTOR_LEN;
        const ptr3 = passStringToWasm0(fee_msat, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len3 = WASM_VECTOR_LEN;
        const ptr4 = passStringToWasm0(claim_pk, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len4 = WASM_VECTOR_LEN;
        const ptr5 = passStringToWasm0(refund_pk, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len5 = WASM_VECTOR_LEN;
        const ptr6 = passStringToWasm0(donations, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len6 = WASM_VECTOR_LEN;
        const ret = wasm.lockclient_lockWithDonations(this.__wbg_ptr, ptr0, len0, ptr1, len1, ptr2, len2, ptr3, len3, ptr4, len4, ptr5, len5, expiry_delta, ptr6, len6);
        return ret;
    }
    /**
     * A client of the federation the invite names - REFUSED unless that
     * federation is `federation_id` (hex, the round's), so a link cannot send
     * the stake to another federation. Its root is the player's own `secret`
     * (32 bytes hex, from their seed, per round), and its state is kept in
     * `store`, the tab's: a page reloaded after the deposit reopens the wallet
     * that holds it - and a deposit still being claimed resumes - instead of
     * joining an empty one.
     * @param {string} invite
     * @param {string} federation_id
     * @param {string} secret
     * @param {any} store
     * @returns {Promise<LockClient>}
     */
    static join(invite, federation_id, secret, store) {
        const ptr0 = passStringToWasm0(invite, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(federation_id, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len1 = WASM_VECTOR_LEN;
        const ptr2 = passStringToWasm0(secret, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len2 = WASM_VECTOR_LEN;
        const ret = wasm.lockclient_join(ptr0, len0, ptr1, len1, ptr2, len2, store);
        return ret;
    }
    /**
     * THE STAKE LOCK: one stock OutgoingContract funded from this client's
     * ecash, then what the guardians stored at its outpoint beside what was
     * computed. `point`, `claim_pk`, `refund_pk` are 33-byte compressed hex.
     * @param {string} point
     * @param {string} amount_msat
     * @param {string} claim_pk
     * @param {string} refund_pk
     * @param {number} expiry_delta
     * @returns {Promise<string>}
     */
    lock(point, amount_msat, claim_pk, refund_pk, expiry_delta) {
        const ptr0 = passStringToWasm0(point, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(amount_msat, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len1 = WASM_VECTOR_LEN;
        const ptr2 = passStringToWasm0(claim_pk, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len2 = WASM_VECTOR_LEN;
        const ptr3 = passStringToWasm0(refund_pk, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len3 = WASM_VECTOR_LEN;
        const ret = wasm.lockclient_lock(this.__wbg_ptr, ptr0, len0, ptr1, len1, ptr2, len2, ptr3, len3, expiry_delta);
        return ret;
    }
    /**
     * THE PLAYER'S REDEEM OF A FORFEITED LOCK (§23.2 row 1: "the player's own
     * client redeems it, and only the player can"). The lock at `txid:out_idx`,
     * rebuilt from `fields` as `refund` rebuilds it, spent by
     * `OutgoingWitness::Cancel(forfeit)` - the committee's BIP-340 signature by
     * claim_pk over the contract id - and signed by the player's own key. Open
     * at any time, before the expiry or after. The stock contract says whether
     * the forfeit verifies; the transaction is submitted either way, so a
     * forfeit that does not verify is refused by the guardians, not by this
     * client. JSON: { forfeit_verifies, accepted, txid, error, block_count,
     * expiration, stored_before, stored_after, balance_before, balance_after }.
     * @param {string} txid
     * @param {number} out_idx
     * @param {string} fields
     * @param {string} forfeit
     * @param {string} player_secret
     * @returns {Promise<string>}
     */
    redeem(txid, out_idx, fields, forfeit, player_secret) {
        const ptr0 = passStringToWasm0(txid, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(fields, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len1 = WASM_VECTOR_LEN;
        const ptr2 = passStringToWasm0(forfeit, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len2 = WASM_VECTOR_LEN;
        const ptr3 = passStringToWasm0(player_secret, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len3 = WASM_VECTOR_LEN;
        const ret = wasm.lockclient_redeem(this.__wbg_ptr, ptr0, len0, out_idx, ptr1, len1, ptr2, len2, ptr3, len3);
        return ret;
    }
    /**
     * THE PLAYER'S REFUND (§23.2: nobody acted, and the lock expired). The
     * stake lock at `txid:out_idx`, rebuilt from `fields` (the JSON a seat
     * keeps: paymentImage, amountMsat, claimPk, refundPk, expiration), spent by
     * `OutgoingWitness::Refund` and signed by the player's own key -
     * `player_secret`, 32 bytes hex, negated when its point is odd-y, since the
     * lock's refund_pk is the even-y point of the x-only player key. The
     * guardians take it only at or past the lock's expiration; a refusal is
     * reported, not thrown. JSON: { accepted, txid, error, block_count,
     * expiration, stored_before, stored_after, balance_before, balance_after }.
     * @param {string} txid
     * @param {number} out_idx
     * @param {string} fields
     * @param {string} player_secret
     * @returns {Promise<string>}
     */
    refund(txid, out_idx, fields, player_secret) {
        const ptr0 = passStringToWasm0(txid, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(fields, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len1 = WASM_VECTOR_LEN;
        const ptr2 = passStringToWasm0(player_secret, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len2 = WASM_VECTOR_LEN;
        const ret = wasm.lockclient_refund(this.__wbg_ptr, ptr0, len0, out_idx, ptr1, len1, ptr2, len2);
        return ret;
    }
    /**
     * A deposit invoice for `amount_msat` through the gateway at `gateway`, or
     * one the federation lists when `gateway` is empty: JSON { invoice, operation }.
     * @param {string} amount_msat
     * @param {string} gateway
     * @returns {Promise<string>}
     */
    receive(amount_msat, gateway) {
        const ptr0 = passStringToWasm0(amount_msat, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(gateway, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len1 = WASM_VECTOR_LEN;
        const ret = wasm.lockclient_receive(this.__wbg_ptr, ptr0, len0, ptr1, len1);
        return ret;
    }
    /**
     * THE WALLET ON A NEW DEVICE (2026-10-04: "patch Fedimint's recovery so it runs in the browser"): as
     * `join`, but a store that holds no wallet yet is RECOVERED from the federation instead of joined empty - Fedimint's
     * own recovery (mintv2 scans the federation's issuance history for the notes this secret's keys made) runs, and
     * this waits for it. A secret that never held notes recovers an empty wallet; a kept store opens as with `join`.
     * @param {string} invite
     * @param {string} federation_id
     * @param {string} secret
     * @param {any} store
     * @returns {Promise<LockClient>}
     */
    static recover(invite, federation_id, secret, store) {
        const ptr0 = passStringToWasm0(invite, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(federation_id, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len1 = WASM_VECTOR_LEN;
        const ptr2 = passStringToWasm0(secret, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len2 = WASM_VECTOR_LEN;
        const ret = wasm.lockclient_recover(ptr0, len0, ptr1, len1, ptr2, len2, store);
        return ret;
    }
    /**
     * THE FEDERATION'S OWN LNv2 FEE RULE, off its config - `base + amount *
     * ppm / 1e6` on every input and every output (lnv2-common config.rs) - as
     * JSON { fee_ppm, fee_base_msat }. The page's fee-lock gate reads it here,
     * from the federation it joined, and not from a seat's word.
     * @returns {Promise<string>}
     */
    feeRule() {
        const ret = wasm.lockclient_feeRule(this.__wbg_ptr);
        return ret;
    }
    /**
     * THE GATEWAYS THE FEDERATION LISTS (spec §23.1: "made through any gateway the federation lists"): the
     * union of every guardian's registered list, most-listed first - JSON ["https://...", ...]. The page tries them in
     * turn and moves to the next after a timeout.
     * @returns {Promise<string>}
     */
    gateways() {
        const ret = wasm.lockclient_gateways(this.__wbg_ptr);
        return ret;
    }
    /**
     * THE SEND OPERATIONS THIS CLIENT KEEPS (read-only; measured 2026-10-01: a failed withdraw held 8192 msat that did
     * not come back): each with its gateway, contract amount, funding transaction and the federation's answer on it -
     * accepted, rejected with its reason, or undecided after 5 s. Spends nothing.
     * @returns {Promise<string>}
     */
    sendLog() {
        const ret = wasm.lockclient_sendLog(this.__wbg_ptr);
        return ret;
    }
    /**
     * THE WITHDRAW: the stock LNv2 send of this client's ecash to `invoice`
     * (the player's own wallet's), through a gateway the federation lists. The
     * gateway is paid only against the invoice's preimage; otherwise the
     * contract refunds this client. JSON: { state, preimage, invoice_msat,
     * balance_before, balance_after }.
     * @param {string} invoice
     * @param {string | null} [preferred]
     * @returns {Promise<string>}
     */
    withdraw(invoice, preferred) {
        const ptr0 = passStringToWasm0(invoice, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        var ptr1 = isLikeNone(preferred) ? 0 : passStringToWasm0(preferred, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        var len1 = WASM_VECTOR_LEN;
        const ret = wasm.lockclient_withdraw(this.__wbg_ptr, ptr0, len0, ptr1, len1);
        return ret;
    }
    /**
     * THE FEDERATION'S GUARDIANS, off the config this client downloaded and
     * checked on join (2026-09-15 07:33: every guardian has its own
     * bond) - as JSON { federation_id, guardians, threshold, keys: [{ peer, key }] }.
     * Each key is the guardian's 33-byte broadcast key, the one a census node
     * advertises under guardian_of[] (§5A.1); the threshold is the federation's
     * own n - floor((n-1)/3) over its API endpoints, which its id hashes. The
     * same read as the seats' stake-lock `--mode guardians`, so the page counts
     * bonded guardians against the federation's word and not a seat's.
     * @returns {Promise<string>}
     */
    guardians() {
        const ret = wasm.lockclient_guardians(this.__wbg_ptr);
        return ret;
    }
    /**
     * @param {string} point
     * @param {string} stake_msat
     * @param {string} fee_hash
     * @param {string} fee_msat
     * @param {string} claim_pk
     * @param {string} refund_pk
     * @param {number} expiry_delta
     * @returns {Promise<string>}
     */
    lockBoth(point, stake_msat, fee_hash, fee_msat, claim_pk, refund_pk, expiry_delta) {
        const ptr0 = passStringToWasm0(point, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(stake_msat, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len1 = WASM_VECTOR_LEN;
        const ptr2 = passStringToWasm0(fee_hash, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len2 = WASM_VECTOR_LEN;
        const ptr3 = passStringToWasm0(fee_msat, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len3 = WASM_VECTOR_LEN;
        const ptr4 = passStringToWasm0(claim_pk, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len4 = WASM_VECTOR_LEN;
        const ptr5 = passStringToWasm0(refund_pk, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len5 = WASM_VECTOR_LEN;
        const ret = wasm.lockclient_lockBoth(this.__wbg_ptr, ptr0, len0, ptr1, len1, ptr2, len2, ptr3, len3, ptr4, len4, ptr5, len5, expiry_delta);
        return ret;
    }
    /**
     * THE FEE LOCK (F5, Pick b): the same contract to a HASH image, H(F) -
     * `hash` 32-byte hex - so claiming the fee never publishes the stake's P.
     * @param {string} hash
     * @param {string} amount_msat
     * @param {string} claim_pk
     * @param {string} refund_pk
     * @param {number} expiry_delta
     * @returns {Promise<string>}
     */
    lockHash(hash, amount_msat, claim_pk, refund_pk, expiry_delta) {
        const ptr0 = passStringToWasm0(hash, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(amount_msat, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len1 = WASM_VECTOR_LEN;
        const ptr2 = passStringToWasm0(claim_pk, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len2 = WASM_VECTOR_LEN;
        const ptr3 = passStringToWasm0(refund_pk, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len3 = WASM_VECTOR_LEN;
        const ret = wasm.lockclient_lockHash(this.__wbg_ptr, ptr0, len0, ptr1, len1, ptr2, len2, ptr3, len3, expiry_delta);
        return ret;
    }
    /**
     * THE LOCK SUBMITTED, NOT YET ACCEPTED (2026-10-03, OPEN-LIST-2140 item 3: "A funded paid join of an already-open
     * round is still 3.5-4.7 s from PLAY to the entry committed ... The leftover is the lock's acceptance"). The same
     * transaction as `lockWithDonations` - the stake lock, the fee lock when `fee_hash` is not empty, one payout contract per
     * donation - answered the moment the guardians are handed it: its txid, the operation to await it by, and each output
     * as built. The outputs a client builds come first in its transaction, in the order built (measured on testnet4: stake
     * 0, donations 1 and 2), so the entry can name them now; `lockAccepted` checks every one against what the guardians
     * store once they accept it. JSON: { operation, txid, block_count_at_lock, expiry_delta, with_fee, outputs: [{ out_idx,
     * role, computed_contract_id, computed_expiration, amount_msat, recipient_pk }] }.
     * HOW MANY TWEAKS ARE GROUND AND WAITING: a lock takes one per change note; the lobby keeps the queue
     * (200) full before a join, so lockSubmit does not wait for grinding.
     * @returns {number}
     */
    tweaksReady() {
        const ret = wasm.lockclient_tweaksReady(this.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return ret[0] >>> 0;
    }
    /**
     * The federation an invite code names, as hex - the id a Round Contract carries.
     * @param {string} invite
     * @returns {string}
     */
    static federationIdOf(invite) {
        let deferred3_0;
        let deferred3_1;
        try {
            const ptr0 = passStringToWasm0(invite, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            const len0 = WASM_VECTOR_LEN;
            const ret = wasm.lockclient_federationIdOf(ptr0, len0);
            var ptr2 = ret[0];
            var len2 = ret[1];
            if (ret[3]) {
                ptr2 = 0; len2 = 0;
                throw takeFromExternrefTable0(ret[2]);
            }
            deferred3_0 = ptr2;
            deferred3_1 = len2;
            return getStringFromWasm0(ptr2, len2);
        } finally {
            wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
        }
    }
    /**
     * A BLOCK COUNT THE PAGE KEPT (kanban #625: it survives a reload, the client's own does not): taken when it is newer
     * than the one held, `at_ms` when it was read (ms since the epoch). Built on as a count this client read itself.
     * @param {number} count
     * @param {number} at_ms
     */
    keepBlockCount(count, at_ms) {
        wasm.lockclient_keepBlockCount(this.__wbg_ptr, count, at_ms);
    }
    /**
     * The block count held, for the page to keep: JSON { count, at } or null.
     * @returns {string}
     */
    keptBlockCount() {
        let deferred1_0;
        let deferred1_1;
        try {
            const ret = wasm.lockclient_keptBlockCount(this.__wbg_ptr);
            deferred1_0 = ret[0];
            deferred1_1 = ret[1];
            return getStringFromWasm0(ret[0], ret[1]);
        } finally {
            wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
        }
    }
    /**
     * The federation-fee allowance for a transaction of `amount_msat` BEFORE
     * this client holds notes to quote it with (`lockCostMsat` is a dry run
     * over the notes held, and an empty client cannot run it): the stock
     * `PaymentFee::TRANSACTION_FEE_DEFAULT`, "the fee the gateway uses to
     * cover transaction fees with the federation". Not ours; the quote, once
     * there are notes, is what decides.
     * @param {string} amount_msat
     * @returns {string}
     */
    static lockAllowanceMsat(amount_msat) {
        let deferred3_0;
        let deferred3_1;
        try {
            const ptr0 = passStringToWasm0(amount_msat, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            const len0 = WASM_VECTOR_LEN;
            const ret = wasm.lockclient_lockAllowanceMsat(ptr0, len0);
            var ptr2 = ret[0];
            var len2 = ret[1];
            if (ret[3]) {
                ptr2 = 0; len2 = 0;
                throw takeFromExternrefTable0(ret[2]);
            }
            deferred3_0 = ptr2;
            deferred3_1 = len2;
            return getStringFromWasm0(ptr2, len2);
        } finally {
            wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
        }
    }
    /**
     * The id of the contract a lock's fields build (hex) - the builder the redeem uses, reachable without a federation.
     * @param {string} fields
     * @returns {string}
     */
    static outgoingContractId(fields) {
        let deferred3_0;
        let deferred3_1;
        try {
            const ptr0 = passStringToWasm0(fields, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            const len0 = WASM_VECTOR_LEN;
            const ret = wasm.lockclient_outgoingContractId(ptr0, len0);
            var ptr2 = ret[0];
            var len2 = ret[1];
            if (ret[3]) {
                ptr2 = 0; len2 = 0;
                throw takeFromExternrefTable0(ret[2]);
            }
            deferred3_0 = ptr2;
            deferred3_1 = len2;
            return getStringFromWasm0(ptr2, len2);
        } finally {
            wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
        }
    }
}
if (Symbol.dispose) LockClient.prototype[Symbol.dispose] = LockClient.prototype.free;

/**
 * A PANIC IS SAID, NOT SWALLOWED. Without this a panic in the stock client is
 * a bare `RuntimeError: unreachable` and the page's promise never settles -
 * measured: a reloaded page sat on "recovering" with no word of why.
 */
export function said_on_panic() {
    wasm.said_on_panic();
}

const EXPECTED_RESPONSE_TYPES = new Set(['basic', 'cors', 'default']);

async function __wbg_load(module, imports) {
    if (typeof Response === 'function' && module instanceof Response) {
        if (typeof WebAssembly.instantiateStreaming === 'function') {
            try {
                return await WebAssembly.instantiateStreaming(module, imports);
            } catch (e) {
                const validResponse = module.ok && EXPECTED_RESPONSE_TYPES.has(module.type);

                if (validResponse && module.headers.get('Content-Type') !== 'application/wasm') {
                    console.warn("`WebAssembly.instantiateStreaming` failed because your server does not serve Wasm with `application/wasm` MIME type. Falling back to `WebAssembly.instantiate` which is slower. Original error:\n", e);

                } else {
                    throw e;
                }
            }
        }

        const bytes = await module.arrayBuffer();
        return await WebAssembly.instantiate(bytes, imports);
    } else {
        const instance = await WebAssembly.instantiate(module, imports);

        if (instance instanceof WebAssembly.Instance) {
            return { instance, module };
        } else {
            return instance;
        }
    }
}

function __wbg_get_imports() {
    const imports = {};
    imports.wbg = {};
    imports.wbg.__wbg_Error_52673b7de5a0ca89 = function(arg0, arg1) {
        const ret = Error(getStringFromWasm0(arg0, arg1));
        return ret;
    };
    imports.wbg.__wbg___blwp178_0c5b680243813483 = function() { return handleError(function (arg0) {
        globalThis.__blwp178(arg0);
    }, arguments) };
    imports.wbg.__wbg___wbindgen_boolean_get_dea25b33882b895b = function(arg0) {
        const v = arg0;
        const ret = typeof(v) === 'boolean' ? v : undefined;
        return isLikeNone(ret) ? 0xFFFFFF : ret ? 1 : 0;
    };
    imports.wbg.__wbg___wbindgen_debug_string_adfb662ae34724b6 = function(arg0, arg1) {
        const ret = debugString(arg1);
        const ptr1 = passStringToWasm0(ret, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len1 = WASM_VECTOR_LEN;
        getDataViewMemory0().setInt32(arg0 + 4 * 1, len1, true);
        getDataViewMemory0().setInt32(arg0 + 4 * 0, ptr1, true);
    };
    imports.wbg.__wbg___wbindgen_is_function_8d400b8b1af978cd = function(arg0) {
        const ret = typeof(arg0) === 'function';
        return ret;
    };
    imports.wbg.__wbg___wbindgen_is_object_ce774f3490692386 = function(arg0) {
        const val = arg0;
        const ret = typeof(val) === 'object' && val !== null;
        return ret;
    };
    imports.wbg.__wbg___wbindgen_is_string_704ef9c8fc131030 = function(arg0) {
        const ret = typeof(arg0) === 'string';
        return ret;
    };
    imports.wbg.__wbg___wbindgen_is_undefined_f6b95eab589e0269 = function(arg0) {
        const ret = arg0 === undefined;
        return ret;
    };
    imports.wbg.__wbg___wbindgen_string_get_a2a31e16edf96e42 = function(arg0, arg1) {
        const obj = arg1;
        const ret = typeof(obj) === 'string' ? obj : undefined;
        var ptr1 = isLikeNone(ret) ? 0 : passStringToWasm0(ret, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        var len1 = WASM_VECTOR_LEN;
        getDataViewMemory0().setInt32(arg0 + 4 * 1, len1, true);
        getDataViewMemory0().setInt32(arg0 + 4 * 0, ptr1, true);
    };
    imports.wbg.__wbg___wbindgen_throw_dd24417ed36fc46e = function(arg0, arg1) {
        throw new Error(getStringFromWasm0(arg0, arg1));
    };
    imports.wbg.__wbg__wbg_cb_unref_87dfb5aaa0cbcea7 = function(arg0) {
        arg0._wbg_cb_unref();
    };
    imports.wbg.__wbg_abort_07646c894ebbf2bd = function(arg0) {
        arg0.abort();
    };
    imports.wbg.__wbg_abort_399ecbcfd6ef3c8e = function(arg0, arg1) {
        arg0.abort(arg1);
    };
    imports.wbg.__wbg_addEventListener_6a82629b3d430a48 = function() { return handleError(function (arg0, arg1, arg2, arg3) {
        arg0.addEventListener(getStringFromWasm0(arg1, arg2), arg3);
    }, arguments) };
    imports.wbg.__wbg_addEventListener_82cddc614107eb45 = function() { return handleError(function (arg0, arg1, arg2, arg3, arg4) {
        arg0.addEventListener(getStringFromWasm0(arg1, arg2), arg3, arg4);
    }, arguments) };
    imports.wbg.__wbg_addEventListener_e792423147a80626 = function() { return handleError(function (arg0, arg1, arg2, arg3) {
        arg0.addEventListener(getStringFromWasm0(arg1, arg2), arg3);
    }, arguments) };
    imports.wbg.__wbg_append_c5cbdf46455cc776 = function() { return handleError(function (arg0, arg1, arg2, arg3, arg4) {
        arg0.append(getStringFromWasm0(arg1, arg2), getStringFromWasm0(arg3, arg4));
    }, arguments) };
    imports.wbg.__wbg_arrayBuffer_c04af4fce566092d = function() { return handleError(function (arg0) {
        const ret = arg0.arrayBuffer();
        return ret;
    }, arguments) };
    imports.wbg.__wbg_body_947b901c33f7fe32 = function(arg0) {
        const ret = arg0.body;
        return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
    };
    imports.wbg.__wbg_buffer_6cb2fecb1f253d71 = function(arg0) {
        const ret = arg0.buffer;
        return ret;
    };
    imports.wbg.__wbg_byobRequest_f8e3517f5f8ad284 = function(arg0) {
        const ret = arg0.byobRequest;
        return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
    };
    imports.wbg.__wbg_byteLength_faa9938885bdeee6 = function(arg0) {
        const ret = arg0.byteLength;
        return ret;
    };
    imports.wbg.__wbg_byteOffset_3868b6a19ba01dea = function(arg0) {
        const ret = arg0.byteOffset;
        return ret;
    };
    imports.wbg.__wbg_call_3020136f7a2d6e44 = function() { return handleError(function (arg0, arg1, arg2) {
        const ret = arg0.call(arg1, arg2);
        return ret;
    }, arguments) };
    imports.wbg.__wbg_call_abb4ff46ce38be40 = function() { return handleError(function (arg0, arg1) {
        const ret = arg0.call(arg1);
        return ret;
    }, arguments) };
    imports.wbg.__wbg_cancel_a65cf45dca50ba4c = function(arg0) {
        const ret = arg0.cancel();
        return ret;
    };
    imports.wbg.__wbg_catch_b9db41d97d42bd02 = function(arg0, arg1) {
        const ret = arg0.catch(arg1);
        return ret;
    };
    imports.wbg.__wbg_clearTimeout_15dfc3d1dcb635c6 = function() { return handleError(function (arg0, arg1) {
        arg0.clearTimeout(arg1);
    }, arguments) };
    imports.wbg.__wbg_clearTimeout_3b5c565a5ec539dd = function(arg0) {
        const ret = clearTimeout(arg0);
        return ret;
    };
    imports.wbg.__wbg_clearTimeout_42d9ccd50822fd3a = function(arg0) {
        const ret = clearTimeout(arg0);
        return ret;
    };
    imports.wbg.__wbg_clearTimeout_5e42188b495715bb = function() { return handleError(function (arg0, arg1) {
        arg0.clearTimeout(arg1);
    }, arguments) };
    imports.wbg.__wbg_clearTimeout_96804de0ab838f26 = function(arg0) {
        const ret = clearTimeout(arg0);
        return ret;
    };
    imports.wbg.__wbg_close_0af5661bf3d335f2 = function() { return handleError(function (arg0) {
        arg0.close();
    }, arguments) };
    imports.wbg.__wbg_close_1db3952de1b5b1cf = function() { return handleError(function (arg0) {
        arg0.close();
    }, arguments) };
    imports.wbg.__wbg_close_3ec111e7b23d94d8 = function() { return handleError(function (arg0) {
        arg0.close();
    }, arguments) };
    imports.wbg.__wbg_code_85a811fe6ca962be = function(arg0) {
        const ret = arg0.code;
        return ret;
    };
    imports.wbg.__wbg_code_c2a85f2863ec11b3 = function(arg0) {
        const ret = arg0.code;
        return ret;
    };
    imports.wbg.__wbg_crypto_574e78ad8b13b65f = function(arg0) {
        const ret = arg0.crypto;
        return ret;
    };
    imports.wbg.__wbg_data_8bf4ae669a78a688 = function(arg0) {
        const ret = arg0.data;
        return ret;
    };
    imports.wbg.__wbg_dispatchEvent_50a40ea5c664f9f4 = function() { return handleError(function (arg0, arg1) {
        const ret = arg0.dispatchEvent(arg1);
        return ret;
    }, arguments) };
    imports.wbg.__wbg_done_62ea16af4ce34b24 = function(arg0) {
        const ret = arg0.done;
        return ret;
    };
    imports.wbg.__wbg_enqueue_a7e6b1ee87963aad = function() { return handleError(function (arg0, arg1) {
        arg0.enqueue(arg1);
    }, arguments) };
    imports.wbg.__wbg_entries_13da0847a5239578 = function(arg0) {
        const ret = arg0.entries();
        return ret;
    };
    imports.wbg.__wbg_entries_e434c9be1432c2c6 = function() { return handleError(function (arg0, arg1) {
        const ret = arg1.entries();
        const ptr1 = passStringToWasm0(ret, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len1 = WASM_VECTOR_LEN;
        getDataViewMemory0().setInt32(arg0 + 4 * 1, len1, true);
        getDataViewMemory0().setInt32(arg0 + 4 * 0, ptr1, true);
    }, arguments) };
    imports.wbg.__wbg_error_2d4d85d4547e2c48 = function(arg0, arg1) {
        console.error(getStringFromWasm0(arg0, arg1));
    };
    imports.wbg.__wbg_fetch_16dcf1cfbbc66b3c = function(arg0) {
        const ret = fetch(arg0);
        return ret;
    };
    imports.wbg.__wbg_fetch_6bbc32f991730587 = function(arg0) {
        const ret = fetch(arg0);
        return ret;
    };
    imports.wbg.__wbg_fetch_90447c28cc0b095e = function(arg0, arg1) {
        const ret = arg0.fetch(arg1);
        return ret;
    };
    imports.wbg.__wbg_getRandomValues_3c9c0d586e575a16 = function() { return handleError(function (arg0, arg1) {
        globalThis.crypto.getRandomValues(getArrayU8FromWasm0(arg0, arg1));
    }, arguments) };
    imports.wbg.__wbg_getRandomValues_b8f5dbd5f3995a9e = function() { return handleError(function (arg0, arg1) {
        arg0.getRandomValues(arg1);
    }, arguments) };
    imports.wbg.__wbg_getRandomValues_e9de607763a970bd = function() { return handleError(function (arg0, arg1) {
        globalThis.crypto.getRandomValues(getArrayU8FromWasm0(arg0, arg1));
    }, arguments) };
    imports.wbg.__wbg_getReader_48e00749fe3f6089 = function() { return handleError(function (arg0) {
        const ret = arg0.getReader();
        return ret;
    }, arguments) };
    imports.wbg.__wbg_getTime_ad1e9878a735af08 = function(arg0) {
        const ret = arg0.getTime();
        return ret;
    };
    imports.wbg.__wbg_get_6b7bd52aca3f9671 = function(arg0, arg1) {
        const ret = arg0[arg1 >>> 0];
        return ret;
    };
    imports.wbg.__wbg_get_af9dab7e9603ea93 = function() { return handleError(function (arg0, arg1) {
        const ret = Reflect.get(arg0, arg1);
        return ret;
    }, arguments) };
    imports.wbg.__wbg_get_done_f98a6e62c4e18fb9 = function(arg0) {
        const ret = arg0.done;
        return isLikeNone(ret) ? 0xFFFFFF : ret ? 1 : 0;
    };
    imports.wbg.__wbg_get_value_63e39884ef11812e = function(arg0) {
        const ret = arg0.value;
        return ret;
    };
    imports.wbg.__wbg_has_0e670569d65d3a45 = function() { return handleError(function (arg0, arg1) {
        const ret = Reflect.has(arg0, arg1);
        return ret;
    }, arguments) };
    imports.wbg.__wbg_headers_654c30e1bcccc552 = function(arg0) {
        const ret = arg0.headers;
        return ret;
    };
    imports.wbg.__wbg_instanceof_ArrayBuffer_f3320d2419cd0355 = function(arg0) {
        let result;
        try {
            result = arg0 instanceof ArrayBuffer;
        } catch (_) {
            result = false;
        }
        const ret = result;
        return ret;
    };
    imports.wbg.__wbg_instanceof_Blob_e9c51ce33a4b6181 = function(arg0) {
        let result;
        try {
            result = arg0 instanceof Blob;
        } catch (_) {
            result = false;
        }
        const ret = result;
        return ret;
    };
    imports.wbg.__wbg_instanceof_Error_3443650560328fa9 = function(arg0) {
        let result;
        try {
            result = arg0 instanceof Error;
        } catch (_) {
            result = false;
        }
        const ret = result;
        return ret;
    };
    imports.wbg.__wbg_instanceof_Response_cd74d1c2ac92cb0b = function(arg0) {
        let result;
        try {
            result = arg0 instanceof Response;
        } catch (_) {
            result = false;
        }
        const ret = result;
        return ret;
    };
    imports.wbg.__wbg_isArray_51fd9e6422c0a395 = function(arg0) {
        const ret = Array.isArray(arg0);
        return ret;
    };
    imports.wbg.__wbg_iterator_27b7c8b35ab3e86b = function() {
        const ret = Symbol.iterator;
        return ret;
    };
    imports.wbg.__wbg_length_22ac23eaec9d8053 = function(arg0) {
        const ret = arg0.length;
        return ret;
    };
    imports.wbg.__wbg_lockclient_new = function(arg0) {
        const ret = LockClient.__wrap(arg0);
        return ret;
    };
    imports.wbg.__wbg_message_0305fa7903f4b3d9 = function(arg0) {
        const ret = arg0.message;
        return ret;
    };
    imports.wbg.__wbg_message_a4e9a39ee8f92b17 = function(arg0, arg1) {
        const ret = arg1.message;
        const ptr1 = passStringToWasm0(ret, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len1 = WASM_VECTOR_LEN;
        getDataViewMemory0().setInt32(arg0 + 4 * 1, len1, true);
        getDataViewMemory0().setInt32(arg0 + 4 * 0, ptr1, true);
    };
    imports.wbg.__wbg_msCrypto_a61aeb35a24c1329 = function(arg0) {
        const ret = arg0.msCrypto;
        return ret;
    };
    imports.wbg.__wbg_name_f33243968228ce95 = function(arg0) {
        const ret = arg0.name;
        return ret;
    };
    imports.wbg.__wbg_new_0_23cedd11d9b40c9d = function() {
        const ret = new Date();
        return ret;
    };
    imports.wbg.__wbg_new_1ba21ce319a06297 = function() {
        const ret = new Object();
        return ret;
    };
    imports.wbg.__wbg_new_25f239778d6112b9 = function() {
        const ret = new Array();
        return ret;
    };
    imports.wbg.__wbg_new_3c79b3bb1b32b7d3 = function() { return handleError(function () {
        const ret = new Headers();
        return ret;
    }, arguments) };
    imports.wbg.__wbg_new_6421f6084cc5bc5a = function(arg0) {
        const ret = new Uint8Array(arg0);
        return ret;
    };
    imports.wbg.__wbg_new_7c30d1f874652e62 = function() { return handleError(function (arg0, arg1) {
        const ret = new WebSocket(getStringFromWasm0(arg0, arg1));
        return ret;
    }, arguments) };
    imports.wbg.__wbg_new_881a222c65f168fc = function() { return handleError(function () {
        const ret = new AbortController();
        return ret;
    }, arguments) };
    imports.wbg.__wbg_new_df1173567d5ff028 = function(arg0, arg1) {
        const ret = new Error(getStringFromWasm0(arg0, arg1));
        return ret;
    };
    imports.wbg.__wbg_new_ff12d2b041fb48f1 = function(arg0, arg1) {
        try {
            var state0 = {a: arg0, b: arg1};
            var cb0 = (arg0, arg1) => {
                const a = state0.a;
                state0.a = 0;
                try {
                    return wasm_bindgen_a3ba67b85167eb47___convert__closures_____invoke___wasm_bindgen_a3ba67b85167eb47___JsValue__wasm_bindgen_a3ba67b85167eb47___JsValue_____(a, state0.b, arg0, arg1);
                } finally {
                    state0.a = a;
                }
            };
            const ret = new Promise(cb0);
            return ret;
        } finally {
            state0.a = state0.b = 0;
        }
    };
    imports.wbg.__wbg_new_from_slice_f9c22b9153b26992 = function(arg0, arg1) {
        const ret = new Uint8Array(getArrayU8FromWasm0(arg0, arg1));
        return ret;
    };
    imports.wbg.__wbg_new_no_args_cb138f77cf6151ee = function(arg0, arg1) {
        const ret = new Function(getStringFromWasm0(arg0, arg1));
        return ret;
    };
    imports.wbg.__wbg_new_with_byte_offset_and_length_d85c3da1fd8df149 = function(arg0, arg1, arg2) {
        const ret = new Uint8Array(arg0, arg1 >>> 0, arg2 >>> 0);
        return ret;
    };
    imports.wbg.__wbg_new_with_event_init_dict_8ce3ab55b0239ca3 = function() { return handleError(function (arg0, arg1, arg2) {
        const ret = new CloseEvent(getStringFromWasm0(arg0, arg1), arg2);
        return ret;
    }, arguments) };
    imports.wbg.__wbg_new_with_length_aa5eaf41d35235e5 = function(arg0) {
        const ret = new Uint8Array(arg0 >>> 0);
        return ret;
    };
    imports.wbg.__wbg_new_with_str_and_init_c5748f76f5108934 = function() { return handleError(function (arg0, arg1, arg2) {
        const ret = new Request(getStringFromWasm0(arg0, arg1), arg2);
        return ret;
    }, arguments) };
    imports.wbg.__wbg_new_with_str_sequence_073466a4a5387941 = function() { return handleError(function (arg0, arg1, arg2) {
        const ret = new WebSocket(getStringFromWasm0(arg0, arg1), arg2);
        return ret;
    }, arguments) };
    imports.wbg.__wbg_next_138a17bbf04e926c = function(arg0) {
        const ret = arg0.next;
        return ret;
    };
    imports.wbg.__wbg_next_3cfe5c0fe2a4cc53 = function() { return handleError(function (arg0) {
        const ret = arg0.next();
        return ret;
    }, arguments) };
    imports.wbg.__wbg_node_905d3e251edff8a2 = function(arg0) {
        const ret = arg0.node;
        return ret;
    };
    imports.wbg.__wbg_now_2c95c9de01293173 = function(arg0) {
        const ret = arg0.now();
        return ret;
    };
    imports.wbg.__wbg_now_69d776cd24f5215b = function() {
        const ret = Date.now();
        return ret;
    };
    imports.wbg.__wbg_now_7b176e1733a5f940 = function() {
        const ret = Date.now();
        return ret;
    };
    imports.wbg.__wbg_now_f689eeb9c785ac0d = function() {
        const ret = performance.now();
        return ret;
    };
    imports.wbg.__wbg_performance_7a3ffd0b17f663ad = function(arg0) {
        const ret = arg0.performance;
        return ret;
    };
    imports.wbg.__wbg_process_dc0fbacc7c1c06f7 = function(arg0) {
        const ret = arg0.process;
        return ret;
    };
    imports.wbg.__wbg_protocol_a74f36816d507cab = function(arg0, arg1) {
        const ret = arg1.protocol;
        const ptr1 = passStringToWasm0(ret, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len1 = WASM_VECTOR_LEN;
        getDataViewMemory0().setInt32(arg0 + 4 * 1, len1, true);
        getDataViewMemory0().setInt32(arg0 + 4 * 0, ptr1, true);
    };
    imports.wbg.__wbg_prototypesetcall_dfe9b766cdc1f1fd = function(arg0, arg1, arg2) {
        Uint8Array.prototype.set.call(getArrayU8FromWasm0(arg0, arg1), arg2);
    };
    imports.wbg.__wbg_push_7d9be8f38fc13975 = function(arg0, arg1) {
        const ret = arg0.push(arg1);
        return ret;
    };
    imports.wbg.__wbg_put_f39d0ccd997fcf9c = function() { return handleError(function (arg0, arg1, arg2, arg3, arg4) {
        arg0.put(getStringFromWasm0(arg1, arg2), getStringFromWasm0(arg3, arg4));
    }, arguments) };
    imports.wbg.__wbg_queueMicrotask_9b549dfce8865860 = function(arg0) {
        const ret = arg0.queueMicrotask;
        return ret;
    };
    imports.wbg.__wbg_queueMicrotask_fca69f5bfad613a5 = function(arg0) {
        queueMicrotask(arg0);
    };
    imports.wbg.__wbg_randomFillSync_ac0988aba3254290 = function() { return handleError(function (arg0, arg1) {
        arg0.randomFillSync(arg1);
    }, arguments) };
    imports.wbg.__wbg_read_39c4b35efcd03c25 = function(arg0) {
        const ret = arg0.read();
        return ret;
    };
    imports.wbg.__wbg_readyState_9d0976dcad561aa9 = function(arg0) {
        const ret = arg0.readyState;
        return ret;
    };
    imports.wbg.__wbg_reason_d4eb9e40592438c2 = function(arg0, arg1) {
        const ret = arg1.reason;
        const ptr1 = passStringToWasm0(ret, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len1 = WASM_VECTOR_LEN;
        getDataViewMemory0().setInt32(arg0 + 4 * 1, len1, true);
        getDataViewMemory0().setInt32(arg0 + 4 * 0, ptr1, true);
    };
    imports.wbg.__wbg_releaseLock_a5912f590b185180 = function(arg0) {
        arg0.releaseLock();
    };
    imports.wbg.__wbg_removeEventListener_54bf92f4a849bd7d = function() { return handleError(function (arg0, arg1, arg2, arg3) {
        arg0.removeEventListener(getStringFromWasm0(arg1, arg2), arg3);
    }, arguments) };
    imports.wbg.__wbg_removeEventListener_565e273024b68b75 = function() { return handleError(function (arg0, arg1, arg2, arg3) {
        arg0.removeEventListener(getStringFromWasm0(arg1, arg2), arg3);
    }, arguments) };
    imports.wbg.__wbg_remove_e83dee71c97115cc = function() { return handleError(function (arg0, arg1, arg2) {
        arg0.remove(getStringFromWasm0(arg1, arg2));
    }, arguments) };
    imports.wbg.__wbg_require_60cc747a6bc5215a = function() { return handleError(function () {
        const ret = module.require;
        return ret;
    }, arguments) };
    imports.wbg.__wbg_resolve_fd5bfbaa4ce36e1e = function(arg0) {
        const ret = Promise.resolve(arg0);
        return ret;
    };
    imports.wbg.__wbg_respond_9f7fc54636c4a3af = function() { return handleError(function (arg0, arg1) {
        arg0.respond(arg1 >>> 0);
    }, arguments) };
    imports.wbg.__wbg_send_7cc36bb628044281 = function() { return handleError(function (arg0, arg1, arg2) {
        arg0.send(getStringFromWasm0(arg1, arg2));
    }, arguments) };
    imports.wbg.__wbg_send_ea59e150ab5ebe08 = function() { return handleError(function (arg0, arg1, arg2) {
        arg0.send(getArrayU8FromWasm0(arg1, arg2));
    }, arguments) };
    imports.wbg.__wbg_setTimeout_2b111259203a2623 = function() { return handleError(function (arg0, arg1, arg2) {
        const ret = arg0.setTimeout(arg1, arg2);
        return ret;
    }, arguments) };
    imports.wbg.__wbg_setTimeout_4eb823e8b72fbe79 = function() { return handleError(function (arg0, arg1, arg2) {
        const ret = arg0.setTimeout(arg1, arg2);
        return ret;
    }, arguments) };
    imports.wbg.__wbg_setTimeout_4ec014681668a581 = function(arg0, arg1) {
        const ret = setTimeout(arg0, arg1);
        return ret;
    };
    imports.wbg.__wbg_setTimeout_cb2a856ba8315e7a = function(arg0, arg1) {
        const ret = setTimeout(arg0, arg1);
        return ret;
    };
    imports.wbg.__wbg_setTimeout_eefe7f4c234b0c6b = function() { return handleError(function (arg0, arg1) {
        const ret = setTimeout(arg0, arg1);
        return ret;
    }, arguments) };
    imports.wbg.__wbg_set_169e13b608078b7b = function(arg0, arg1, arg2) {
        arg0.set(getArrayU8FromWasm0(arg1, arg2));
    };
    imports.wbg.__wbg_set_binaryType_73e8c75df97825f8 = function(arg0, arg1) {
        arg0.binaryType = __wbindgen_enum_BinaryType[arg1];
    };
    imports.wbg.__wbg_set_body_8e743242d6076a4f = function(arg0, arg1) {
        arg0.body = arg1;
    };
    imports.wbg.__wbg_set_cache_0e437c7c8e838b9b = function(arg0, arg1) {
        arg0.cache = __wbindgen_enum_RequestCache[arg1];
    };
    imports.wbg.__wbg_set_code_2f1b419c1a6169a3 = function(arg0, arg1) {
        arg0.code = arg1;
    };
    imports.wbg.__wbg_set_credentials_55ae7c3c106fd5be = function(arg0, arg1) {
        arg0.credentials = __wbindgen_enum_RequestCredentials[arg1];
    };
    imports.wbg.__wbg_set_handle_event_14baa3949ef6909d = function(arg0, arg1) {
        arg0.handleEvent = arg1;
    };
    imports.wbg.__wbg_set_headers_5671cf088e114d2b = function(arg0, arg1) {
        arg0.headers = arg1;
    };
    imports.wbg.__wbg_set_method_76c69e41b3570627 = function(arg0, arg1, arg2) {
        arg0.method = getStringFromWasm0(arg1, arg2);
    };
    imports.wbg.__wbg_set_mode_611016a6818fc690 = function(arg0, arg1) {
        arg0.mode = __wbindgen_enum_RequestMode[arg1];
    };
    imports.wbg.__wbg_set_once_cb88c6a887803dfa = function(arg0, arg1) {
        arg0.once = arg1 !== 0;
    };
    imports.wbg.__wbg_set_onclose_032729b3d7ed7a9e = function(arg0, arg1) {
        arg0.onclose = arg1;
    };
    imports.wbg.__wbg_set_onerror_7819daa6af176ddb = function(arg0, arg1) {
        arg0.onerror = arg1;
    };
    imports.wbg.__wbg_set_onmessage_71321d0bed69856c = function(arg0, arg1) {
        arg0.onmessage = arg1;
    };
    imports.wbg.__wbg_set_onopen_6d4abedb27ba5656 = function(arg0, arg1) {
        arg0.onopen = arg1;
    };
    imports.wbg.__wbg_set_reason_6cb672258b901b3a = function(arg0, arg1, arg2) {
        arg0.reason = getStringFromWasm0(arg1, arg2);
    };
    imports.wbg.__wbg_set_signal_e89be862d0091009 = function(arg0, arg1) {
        arg0.signal = arg1;
    };
    imports.wbg.__wbg_signal_3c14fbdc89694b39 = function(arg0) {
        const ret = arg0.signal;
        return ret;
    };
    imports.wbg.__wbg_static_accessor_GLOBAL_769e6b65d6557335 = function() {
        const ret = typeof global === 'undefined' ? null : global;
        return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
    };
    imports.wbg.__wbg_static_accessor_GLOBAL_THIS_60cf02db4de8e1c1 = function() {
        const ret = typeof globalThis === 'undefined' ? null : globalThis;
        return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
    };
    imports.wbg.__wbg_static_accessor_SELF_08f5a74c69739274 = function() {
        const ret = typeof self === 'undefined' ? null : self;
        return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
    };
    imports.wbg.__wbg_static_accessor_WINDOW_a8924b26aa92d024 = function() {
        const ret = typeof window === 'undefined' ? null : window;
        return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
    };
    imports.wbg.__wbg_status_9bfc680efca4bdfd = function(arg0) {
        const ret = arg0.status;
        return ret;
    };
    imports.wbg.__wbg_stringify_655a6390e1f5eb6b = function() { return handleError(function (arg0) {
        const ret = JSON.stringify(arg0);
        return ret;
    }, arguments) };
    imports.wbg.__wbg_subarray_845f2f5bce7d061a = function(arg0, arg1, arg2) {
        const ret = arg0.subarray(arg1 >>> 0, arg2 >>> 0);
        return ret;
    };
    imports.wbg.__wbg_then_429f7caf1026411d = function(arg0, arg1, arg2) {
        const ret = arg0.then(arg1, arg2);
        return ret;
    };
    imports.wbg.__wbg_then_4f95312d68691235 = function(arg0, arg1) {
        const ret = arg0.then(arg1);
        return ret;
    };
    imports.wbg.__wbg_toString_14b47ee7542a49ef = function(arg0) {
        const ret = arg0.toString();
        return ret;
    };
    imports.wbg.__wbg_trace_d57a7cd9ef91b393 = function(arg0, arg1) {
        console.trace(getStringFromWasm0(arg0, arg1));
    };
    imports.wbg.__wbg_url_b6d11838a4f95198 = function(arg0, arg1) {
        const ret = arg1.url;
        const ptr1 = passStringToWasm0(ret, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len1 = WASM_VECTOR_LEN;
        getDataViewMemory0().setInt32(arg0 + 4 * 1, len1, true);
        getDataViewMemory0().setInt32(arg0 + 4 * 0, ptr1, true);
    };
    imports.wbg.__wbg_url_df28eef824b04410 = function(arg0, arg1) {
        const ret = arg1.url;
        const ptr1 = passStringToWasm0(ret, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len1 = WASM_VECTOR_LEN;
        getDataViewMemory0().setInt32(arg0 + 4 * 1, len1, true);
        getDataViewMemory0().setInt32(arg0 + 4 * 0, ptr1, true);
    };
    imports.wbg.__wbg_value_57b7b035e117f7ee = function(arg0) {
        const ret = arg0.value;
        return ret;
    };
    imports.wbg.__wbg_versions_c01dfd4722a88165 = function(arg0) {
        const ret = arg0.versions;
        return ret;
    };
    imports.wbg.__wbg_view_788aaf149deefd2f = function(arg0) {
        const ret = arg0.view;
        return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
    };
    imports.wbg.__wbg_wasClean_4154a2d59fdb4dd7 = function(arg0) {
        const ret = arg0.wasClean;
        return ret;
    };
    imports.wbg.__wbindgen_cast_21f4fe1b9f9ef637 = function(arg0, arg1) {
        // Cast intrinsic for `Closure(Closure { dtor_idx: 13055, function: Function { arguments: [], shim_idx: 13056, ret: Unit, inner_ret: Some(Unit) }, mutable: true }) -> Externref`.
        const ret = makeMutClosure(arg0, arg1, wasm.wasm_bindgen_a3ba67b85167eb47___closure__destroy___dyn_core_608f92abc48d28da___ops__function__FnMut_____Output________4_, wasm_bindgen_a3ba67b85167eb47___convert__closures_____invoke_______7_);
        return ret;
    };
    imports.wbg.__wbindgen_cast_2241b6af4c4b2941 = function(arg0, arg1) {
        // Cast intrinsic for `Ref(String) -> Externref`.
        const ret = getStringFromWasm0(arg0, arg1);
        return ret;
    };
    imports.wbg.__wbindgen_cast_279c83870e1f22c5 = function(arg0, arg1) {
        // Cast intrinsic for `Closure(Closure { dtor_idx: 13223, function: Function { arguments: [], shim_idx: 13224, ret: Unit, inner_ret: Some(Unit) }, mutable: true }) -> Externref`.
        const ret = makeMutClosure(arg0, arg1, wasm.wasm_bindgen_a3ba67b85167eb47___closure__destroy___dyn_core_608f92abc48d28da___ops__function__FnMut_____Output________5_, wasm_bindgen_a3ba67b85167eb47___convert__closures_____invoke_______8_);
        return ret;
    };
    imports.wbg.__wbindgen_cast_2ab3023ac27e25a1 = function(arg0, arg1) {
        // Cast intrinsic for `Closure(Closure { dtor_idx: 10397, function: Function { arguments: [NamedExternref("CloseEvent")], shim_idx: 10398, ret: Unit, inner_ret: Some(Unit) }, mutable: true }) -> Externref`.
        const ret = makeMutClosure(arg0, arg1, wasm.wasm_bindgen_a3ba67b85167eb47___closure__destroy___dyn_core_608f92abc48d28da___ops__function__FnMut__web_sys_9de5fc31cbd76c75___features__gen_CloseEvent__CloseEvent____Output________1_, wasm_bindgen_a3ba67b85167eb47___convert__closures_____invoke___web_sys_9de5fc31cbd76c75___features__gen_CloseEvent__CloseEvent______1_);
        return ret;
    };
    imports.wbg.__wbindgen_cast_4597bfc56349174e = function(arg0, arg1) {
        // Cast intrinsic for `Closure(Closure { dtor_idx: 10397, function: Function { arguments: [NamedExternref("Event")], shim_idx: 10398, ret: Unit, inner_ret: Some(Unit) }, mutable: true }) -> Externref`.
        const ret = makeMutClosure(arg0, arg1, wasm.wasm_bindgen_a3ba67b85167eb47___closure__destroy___dyn_core_608f92abc48d28da___ops__function__FnMut__web_sys_9de5fc31cbd76c75___features__gen_CloseEvent__CloseEvent____Output________1_, wasm_bindgen_a3ba67b85167eb47___convert__closures_____invoke___web_sys_9de5fc31cbd76c75___features__gen_CloseEvent__CloseEvent______1_);
        return ret;
    };
    imports.wbg.__wbindgen_cast_47c6881dfe61485d = function(arg0, arg1) {
        // Cast intrinsic for `Closure(Closure { dtor_idx: 11807, function: Function { arguments: [], shim_idx: 11808, ret: Unit, inner_ret: Some(Unit) }, mutable: false }) -> Externref`.
        const ret = makeClosure(arg0, arg1, wasm.wasm_bindgen_a3ba67b85167eb47___closure__destroy___dyn_core_608f92abc48d28da___ops__function__Fn_____Output________1_, wasm_bindgen_a3ba67b85167eb47___convert__closures_____invoke_______5_);
        return ret;
    };
    imports.wbg.__wbindgen_cast_538dbccf02be641e = function(arg0, arg1) {
        // Cast intrinsic for `Closure(Closure { dtor_idx: 13207, function: Function { arguments: [Externref], shim_idx: 13208, ret: Unit, inner_ret: Some(Unit) }, mutable: true }) -> Externref`.
        const ret = makeMutClosure(arg0, arg1, wasm.wasm_bindgen_a3ba67b85167eb47___closure__destroy___dyn_core_608f92abc48d28da___ops__function__FnMut__wasm_bindgen_a3ba67b85167eb47___JsValue____Output_______, wasm_bindgen_a3ba67b85167eb47___convert__closures_____invoke___wasm_bindgen_a3ba67b85167eb47___JsValue_____);
        return ret;
    };
    imports.wbg.__wbindgen_cast_5de6c05a604223f3 = function(arg0, arg1) {
        // Cast intrinsic for `Closure(Closure { dtor_idx: 13028, function: Function { arguments: [NamedExternref("MessageEvent")], shim_idx: 13029, ret: Unit, inner_ret: Some(Unit) }, mutable: true }) -> Externref`.
        const ret = makeMutClosure(arg0, arg1, wasm.wasm_bindgen_a3ba67b85167eb47___closure__destroy___dyn_core_608f92abc48d28da___ops__function__FnMut__web_sys_9de5fc31cbd76c75___features__gen_MessageEvent__MessageEvent____Output_______, wasm_bindgen_a3ba67b85167eb47___convert__closures_____invoke___web_sys_9de5fc31cbd76c75___features__gen_MessageEvent__MessageEvent_____);
        return ret;
    };
    imports.wbg.__wbindgen_cast_7bc6c5f5f90ee7fd = function(arg0, arg1) {
        // Cast intrinsic for `Closure(Closure { dtor_idx: 10397, function: Function { arguments: [], shim_idx: 10402, ret: Unit, inner_ret: Some(Unit) }, mutable: true }) -> Externref`.
        const ret = makeMutClosure(arg0, arg1, wasm.wasm_bindgen_a3ba67b85167eb47___closure__destroy___dyn_core_608f92abc48d28da___ops__function__FnMut__web_sys_9de5fc31cbd76c75___features__gen_CloseEvent__CloseEvent____Output________1_, wasm_bindgen_a3ba67b85167eb47___convert__closures_____invoke_______3_);
        return ret;
    };
    imports.wbg.__wbindgen_cast_883d12bce0cf6fa3 = function(arg0, arg1) {
        // Cast intrinsic for `Closure(Closure { dtor_idx: 11974, function: Function { arguments: [], shim_idx: 11975, ret: Unit, inner_ret: Some(Unit) }, mutable: true }) -> Externref`.
        const ret = makeMutClosure(arg0, arg1, wasm.wasm_bindgen_a3ba67b85167eb47___closure__destroy___dyn_core_608f92abc48d28da___ops__function__FnMut_____Output________3_, wasm_bindgen_a3ba67b85167eb47___convert__closures_____invoke_______6_);
        return ret;
    };
    imports.wbg.__wbindgen_cast_aead20a21041bb25 = function(arg0, arg1) {
        // Cast intrinsic for `Closure(Closure { dtor_idx: 9215, function: Function { arguments: [], shim_idx: 9216, ret: Unit, inner_ret: Some(Unit) }, mutable: true }) -> Externref`.
        const ret = makeMutClosure(arg0, arg1, wasm.wasm_bindgen_a3ba67b85167eb47___closure__destroy___dyn_core_608f92abc48d28da___ops__function__FnMut_____Output_______, wasm_bindgen_a3ba67b85167eb47___convert__closures_____invoke______);
        return ret;
    };
    imports.wbg.__wbindgen_cast_af3eda30427d004f = function(arg0, arg1) {
        // Cast intrinsic for `Closure(Closure { dtor_idx: 10272, function: Function { arguments: [], shim_idx: 10273, ret: Unit, inner_ret: Some(Unit) }, mutable: true }) -> Externref`.
        const ret = makeMutClosure(arg0, arg1, wasm.wasm_bindgen_a3ba67b85167eb47___closure__destroy___dyn_core_608f92abc48d28da___ops__function__FnMut_____Output________1_, wasm_bindgen_a3ba67b85167eb47___convert__closures_____invoke_______2_);
        return ret;
    };
    imports.wbg.__wbindgen_cast_cb9088102bce6b30 = function(arg0, arg1) {
        // Cast intrinsic for `Ref(Slice(U8)) -> NamedExternref("Uint8Array")`.
        const ret = getArrayU8FromWasm0(arg0, arg1);
        return ret;
    };
    imports.wbg.__wbindgen_cast_d4af561d25143359 = function(arg0, arg1) {
        // Cast intrinsic for `Closure(Closure { dtor_idx: 9405, function: Function { arguments: [], shim_idx: 9406, ret: Unit, inner_ret: Some(Unit) }, mutable: false }) -> Externref`.
        const ret = makeClosure(arg0, arg1, wasm.wasm_bindgen_a3ba67b85167eb47___closure__destroy___dyn_core_608f92abc48d28da___ops__function__Fn_____Output_______, wasm_bindgen_a3ba67b85167eb47___convert__closures_____invoke_______1_);
        return ret;
    };
    imports.wbg.__wbindgen_cast_d9c50f1a96a8eec4 = function(arg0, arg1) {
        // Cast intrinsic for `Closure(Closure { dtor_idx: 11803, function: Function { arguments: [], shim_idx: 11804, ret: Unit, inner_ret: Some(Unit) }, mutable: true }) -> Externref`.
        const ret = makeMutClosure(arg0, arg1, wasm.wasm_bindgen_a3ba67b85167eb47___closure__destroy___dyn_core_608f92abc48d28da___ops__function__FnMut_____Output________2_, wasm_bindgen_a3ba67b85167eb47___convert__closures_____invoke_______4_);
        return ret;
    };
    imports.wbg.__wbindgen_cast_e1d2a1b34edef5da = function(arg0, arg1) {
        // Cast intrinsic for `Closure(Closure { dtor_idx: 8345, function: Function { arguments: [NamedExternref("CloseEvent")], shim_idx: 8346, ret: Unit, inner_ret: Some(Unit) }, mutable: true }) -> Externref`.
        const ret = makeMutClosure(arg0, arg1, wasm.wasm_bindgen_a3ba67b85167eb47___closure__destroy___dyn_core_608f92abc48d28da___ops__function__FnMut__web_sys_9de5fc31cbd76c75___features__gen_CloseEvent__CloseEvent____Output_______, wasm_bindgen_a3ba67b85167eb47___convert__closures_____invoke___web_sys_9de5fc31cbd76c75___features__gen_CloseEvent__CloseEvent_____);
        return ret;
    };
    imports.wbg.__wbindgen_cast_ebdaaa422ab122a5 = function(arg0, arg1) {
        // Cast intrinsic for `Closure(Closure { dtor_idx: 11224, function: Function { arguments: [NamedExternref("CloseEvent")], shim_idx: 11225, ret: Unit, inner_ret: Some(Unit) }, mutable: true }) -> Externref`.
        const ret = makeMutClosure(arg0, arg1, wasm.wasm_bindgen_a3ba67b85167eb47___closure__destroy___dyn_core_608f92abc48d28da___ops__function__FnMut__web_sys_9de5fc31cbd76c75___features__gen_CloseEvent__CloseEvent____Output________2_, wasm_bindgen_a3ba67b85167eb47___convert__closures_____invoke___web_sys_9de5fc31cbd76c75___features__gen_CloseEvent__CloseEvent______2_);
        return ret;
    };
    imports.wbg.__wbindgen_cast_f429052598f7a251 = function(arg0, arg1) {
        // Cast intrinsic for `Closure(Closure { dtor_idx: 10397, function: Function { arguments: [NamedExternref("MessageEvent")], shim_idx: 10398, ret: Unit, inner_ret: Some(Unit) }, mutable: true }) -> Externref`.
        const ret = makeMutClosure(arg0, arg1, wasm.wasm_bindgen_a3ba67b85167eb47___closure__destroy___dyn_core_608f92abc48d28da___ops__function__FnMut__web_sys_9de5fc31cbd76c75___features__gen_CloseEvent__CloseEvent____Output________1_, wasm_bindgen_a3ba67b85167eb47___convert__closures_____invoke___web_sys_9de5fc31cbd76c75___features__gen_CloseEvent__CloseEvent______1_);
        return ret;
    };
    imports.wbg.__wbindgen_init_externref_table = function() {
        const table = wasm.__wbindgen_externrefs;
        const offset = table.grow(4);
        table.set(0, undefined);
        table.set(offset + 0, undefined);
        table.set(offset + 1, null);
        table.set(offset + 2, true);
        table.set(offset + 3, false);
    };

    return imports;
}

function __wbg_finalize_init(instance, module) {
    wasm = instance.exports;
    __wbg_init.__wbindgen_wasm_module = module;
    cachedDataViewMemory0 = null;
    cachedUint8ArrayMemory0 = null;


    wasm.__wbindgen_start();
    return wasm;
}

function initSync(module) {
    if (wasm !== undefined) return wasm;


    if (typeof module !== 'undefined') {
        if (Object.getPrototypeOf(module) === Object.prototype) {
            ({module} = module)
        } else {
            console.warn('using deprecated parameters for `initSync()`; pass a single object instead')
        }
    }

    const imports = __wbg_get_imports();
    if (!(module instanceof WebAssembly.Module)) {
        module = new WebAssembly.Module(module);
    }
    const instance = new WebAssembly.Instance(module, imports);
    return __wbg_finalize_init(instance, module);
}

async function __wbg_init(module_or_path) {
    if (wasm !== undefined) return wasm;


    if (typeof module_or_path !== 'undefined') {
        if (Object.getPrototypeOf(module_or_path) === Object.prototype) {
            ({module_or_path} = module_or_path)
        } else {
            console.warn('using deprecated parameters for the initialization function; pass a single object instead')
        }
    }

    if (typeof module_or_path === 'undefined') {
        module_or_path = new URL('blwp_lock_client_bg.wasm', import.meta.url);
    }
    const imports = __wbg_get_imports();

    if (typeof module_or_path === 'string' || (typeof Request === 'function' && module_or_path instanceof Request) || (typeof URL === 'function' && module_or_path instanceof URL)) {
        module_or_path = fetch(module_or_path);
    }

    const { instance, module } = await __wbg_load(await module_or_path, imports);

    return __wbg_finalize_init(instance, module);
}

export { initSync };
export default __wbg_init;
