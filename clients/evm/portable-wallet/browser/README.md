# Browser wallet restore

Choose or drop the encrypted Testnet 1 wallet file, or paste its encrypted contents. Enter the separate recovery code. The restored browser can show your receive commitments, verify spending access on a disposable proof chain or sign an offline native payment. This flow works with backups written by the local companion for ML-DSA-65 and SLH-DSA-SHA2-192s. Every key and nonce must reopen its original full commitment before the browser accepts the wallet. [Wallet backup and native transfer format](../README.md)

If your earlier wallet is one receive folder containing `key.pk8` and the raw `nonce`, open **Import an older command-line wallet**. Select both files and enter the original full public receive commitment. The browser checks the opening locally, creates an encrypted kit for that request and gives you a new recovery code to keep separately. Each folder represents one receive request. For several original folders the desktop converter can collect them in one checked backup. [Multi-folder converter](../README.md#bring-an-existing-key-and-receive-nonce)

To use the tool offline, open the released HTML file in a browser with Web Crypto. Save a verified copy before disconnecting. The app includes its own scripts, styles and favicon. Its CSP pins inline script and style hashes and blocks network connections. The tool accepts public JSON transfer requests following the companion's format. Review the whole amount, full recipient commitment, suite, input and expiry before signing. Anyone with the resulting signed file can submit that payment. Current chain state and final acceptance require a verified validator. [Download the HTML](restore-wallet.html) · [SHA-256 checksum](restore-wallet.html.sha256)

**Remember encrypted backup** is optional and initially off. On explicit selection the tool stores only the authenticated compact JWE ciphertext, even if the pasted text wrapped the ciphertext in a larger JSON object. The next visit can reopen it with the separate code. Browser storage is shared across paths on the same origin and may be unavailable or cleared. Keep the original backup and code separately. **Forget** removes the browser's stored copy. The application does not send either secret to a server. Reloading, navigating away or locking discards the active signer. The browser or operating system controls memory reclamation. Anyone controlling your device, installed extensions or served application could compromise an unlocked wallet.

The browser and companion share the JWE envelope checks and public payment request validation. The browser uses the pinned JOSE implementation with Web Crypto AES-256-GCM and uses the published ledger client for native wire encoding. Its strict PKCS#8 reader supports standard ML-DSA seed, expanded and verified combined representations. It recomputes the SLH public root from the encoded seeds. The post-quantum signer uses Noble’s randomized signing and checks every resulting signature with the derived public key. The library documents a self-review and the timing limitations of JavaScript. An independent wallet or signer audit is pending. [M. Jones and J. Hildebrand, RFC 7516 (2015)](https://www.rfc-editor.org/rfc/rfc7516) · [RFC 9881 §5, ML-DSA private keys](https://www.rfc-editor.org/rfc/rfc9881.html#section-5) · [RFC 9909 §5, SLH-DSA private keys](https://www.rfc-editor.org/rfc/rfc9909.html#section-5) · [Noble security notes](https://github.com/paulmillr/noble-post-quantum/tree/0.7.1#security)

## Rebuild a release

Use Node 26.13.1 or later and run the following in the parent `portable-wallet` directory. The committed lockfile pins the published native ledger client, Noble, JOSE and the build tool. The build writes one standalone HTML file and its SHA-256 digest. A clean rebuild should reproduce the checked-in bytes.

```sh
npm ci
npm run build:browser
git diff --exit-code -- browser/restore-wallet.html browser/restore-wallet.html.sha256
P2PARTY_WALLET_VERIFIER=/absolute/path/to/demos-ledger-verify npm test
```

The browser integration test exercises the release HTML in Chromium and Firefox with generated, valueless fixtures. Install Playwright and its two browser engines in a separate test environment. To use a previous published companion as the archive producer, set `P2PARTY_ARCHIVE_WRITER` to its local wallet.mjs module. The verifier checks the signed bytes exported through the user interface.

```sh
PLAYWRIGHT_MODULE=/absolute/path/to/node_modules/playwright \
P2PARTY_WALLET_VERIFIER=/absolute/path/to/demos-ledger-verify \
node --test browser/standalone.test.mjs
```

For release hosting, publish the same pristine bytes as the directory index and its `restore-wallet.html` sibling so the download link always returns the original release. Use trusted HTTPS hosting, or distribute the standalone file through a trusted channel. An HTML file can be checked offline with its trusted digest. A hash embedded in a page cannot authenticate the server delivering the page.
