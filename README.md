# Credixa Studio

Credixa Studio is a resume-centered career assistant. The frontend is in `frontend/`; the Node.js backend and account API are in `backend/`. It extracts a resume locally, calculates a rubric-based ATS-style estimate, can request source-grounded wording suggestions from a selected LLM, searches live job listings, and ranks them against resume skills and qualifications. It also calculates a local SHA-256 fingerprint and can anchor that fingerprint to an EVM blockchain.

## Run locally

Requirements: Node.js 18 or later. No npm packages are required.

```powershell
npm start
```

Open <http://localhost:3000> in your browser. The signed-in user dashboard is at <http://localhost:3000/dashboard>. Do not open `frontend/index.html` directly as a `file://` URL: the login, saved accounts, and API calls require the backend server.

## Connect providers

Open **Settings** and optionally add:

- An API key for OpenAI, Anthropic, or Google Gemini.
- Optionally, a Tavily Search API key for broader web job and internship search.
- Optionally, a deployed `ResumeRegistry` contract address for on-chain anchoring.

Without an LLM key, Credixa still calculates the defined resume rubric and extracts labeled resume sections; AI wording suggestions remain disabled. Without a Tavily key, job search uses Remotive's public remote-jobs API and ranks results locally. No example or generated job listings are shown. If both live sources are unavailable, search reports the problem and recommends configuring a Tavily key or retrying when the public feed is reachable. Results without valid HTTP(S) links and listings with explicit expired dates or publication dates older than 90 days are excluded. The public Remotive feed can be delayed by up to 24 hours.

Job match percentage is calculated as `matched identifiable skills and qualifications / all identifiable skills and qualifications in the listing × 100`. If a listing does not contain recognizable requirements, Credixa does not display a percentage. The score is a text-overlap aid, not a probability of being hired. Match terms are identified from the listing text, which may not distinguish required from preferred skills; check the linked source for the employer's authoritative requirements and application form.

The first job search is restricted to openings located in India. If the user later enters another location in the refinement form, that location becomes the filter; leaving it blank keeps India selected. If no India-eligible postings are available in the public feed, the app shows no live matches instead of widening the location silently.

The project does not bundle or train an LLM. Provider and search usage can be billed by those services. Keys are held in browser `sessionStorage` for the tab and passed to the local backend only when a request runs; the server does not persist API keys. The resume file is parsed in-browser. Account resume text and review data are encrypted with AES-256-GCM before being written to `backend/data/users.json`; passwords are stored as scrypt hashes. Session cookies are HTTP-only and sessions expire after seven days (sessions are cleared when the server restarts). Search results are public web results; confirm that each employer listing is still open.

## Skill assessment and proctoring

Assessment questions require the existing OpenAI, Anthropic, or Gemini key in **Settings**. Only analyzed resume skills can be selected. The backend validates five multiple-choice questions per selected skill and keeps answer keys server-side. Scoring is one point per correct answer; a skill meets the current assessment criterion at 4/5 correct (80%). This is assessment evidence, not proof of identity or professional competency.

Camera access is requested by the browser after the assessment starts and requires the user to grant permission; localhost and HTTPS are secure contexts. Video is processed locally and is not uploaded or saved. Face landmarks use MediaPipe Tasks Vision from jsDelivr with its model from Google Cloud Storage; camera analysis may be unavailable in browsers that block these assets or lack `getUserMedia`. If permission is denied or camera/model setup fails, the assessment continues and the failure is recorded. Sustained signals use 5 seconds for no face, 2 seconds for multiple faces, 4 seconds for estimated head direction, and 2 seconds for the page to remain hidden. These are review indicators, can be inaccurate, and are not proof of cheating. The third warning can submit current answers or terminate without scoring.

Reports and proctoring events are encrypted within the existing account profile. Active answer keys and assessment sessions are held in server memory and are lost if the server restarts before submission; signed-in sessions are also cleared at restart. Reports are retained up to 20 per account and up to 500 event records.

Run the isolated backend integration test with `npm run test:assessment`. It launches a local mock OpenAI-compatible response and uses a temporary data directory, so it does not call an LLM provider or touch the regular `backend/data` user store. `CREDIXA_DATA_DIR` optionally overrides the profile data directory, and `OPENAI_API_BASE_URL` optionally points the OpenAI-compatible provider at a compatible gateway; defaults remain the local data directory and OpenAI endpoint.

For local development the app creates a random encryption secret at `backend/data/.app-secret`. Keep this file backed up with account data or saved profiles will no longer decrypt. For a deployment, set a stable secret before starting the server, for example in PowerShell:

```powershell
$env:APP_SECRET = "a-long-random-secret-kept-outside-the-repository"
npm start
```

Do not change the secret after accounts have saved data. Never commit `backend/data/` or a production secret. Account creation requires a valid email and a password of at least 12 characters. Email verification, password reset, account deletion, and account recovery are not implemented yet.

## Blockchain setup

1. Deploy [`contracts/ResumeRegistry.sol`](contracts/ResumeRegistry.sol) to an EVM network using Remix or your preferred Solidity toolchain.
2. Connect the browser wallet to that same network.
3. Add the deployed contract address in Settings.
4. Upload the exact resume file and choose **Anchor on blockchain**. The wallet will ask the user to approve a transaction and pay network gas.
5. Keep the file unchanged to verify the fingerprint later with **Check on-chain**. Any content or file-format change creates a different fingerprint.

The contract stores only the SHA-256 fingerprint, registering wallet address, and timestamp. It does not store the resume itself. Deploying the contract and making a transaction require a wallet and network funds; the app does not claim that the resume is confidential merely because its fingerprint is on-chain.

## Verified Skills resume

After saving a resume and completing a skill assessment, sign in and use **Create verification record** in the candidate workspace. A record gets a random 192-bit verification ID and a canonical JSON SHA-256 digest covering the resume-text digest, every extracted resume skill's assessment status, score/counts, difficulty, and assessment date. The original resume and full report remain off-chain in the existing AES-256-GCM encrypted profile. The existing EVM `ResumeRegistry` stores only the 32-byte digest, wallet address, and timestamp; this is not Hyperledger Fabric.

Configure the backend before starting it:

```powershell
$env:PUBLIC_BASE_URL = "https://your-public-credixa-host.example"
$env:EVM_RPC_URL = "https://your-evm-network-rpc.example"
$env:RESUME_REGISTRY_ADDRESS = "0xYourDeployedResumeRegistryAddress"
$env:APP_SECRET = "your-stable-private-encryption-secret"
npm start
```

`PUBLIC_BASE_URL` must be a publicly reachable HTTPS origin for links opened on another device. `EVM_RPC_URL` must be accessible from the Credixa backend and point to the same EVM network used by the browser wallet. Deploy [`contracts/ResumeRegistry.sol`](contracts/ResumeRegistry.sol) to that network and configure its address in both the server environment and the signed-in candidate's Settings. The candidate must use an EVM wallet connected to that network and pay transaction gas. The backend checks the submitted transaction receipt and `ResumeRegistered` event, then the unauthenticated public endpoint re-hashes the current stored record and resume snapshot and reads the contract mapping. If any step fails or data changes, the public page and PDF remain unverified. Only a live hash match allows a passed skill to be labeled verified; that still establishes record integrity, not candidate identity or real-world skill authenticity.

The public page at `/verify/{verificationId}` does not require an account and exposes only the random ID, passed skill names and scores, assessment date, and current integrity status. It never returns the resume or contact details. The PDF includes the resume text locally for the candidate; contact/header details are excluded by default, with an explicit opt-in checkbox to include them. Unassessed skills are labeled **Not Assessed**. A record with no successful ledger match can still be exported, but its badge and skill labels clearly state integrity is not verified.

Run the end-to-end integration test with `npm install` followed by `npm run test:verified-resume`. Development-only `ganache` and `solc` dependencies compile and deploy the existing Solidity contract to an ephemeral local EVM. The test completes an assessment using a local mock LLM, anchors the record, checks the public result, tampers with the encrypted test record, and confirms the public endpoint rejects the modified version. This is a local integration test, not a production ledger; actual deployment requires the real EVM configuration above.

## Verified Skills resume

The candidate workspace can create an immutable snapshot from the encrypted saved resume and completed assessment reports. It includes a random verification ID, SHA-256 of the current resume text, every extracted resume skill's assessment status, score/counts, difficulty, and assessment date. The record is deterministically serialized and SHA-256 hashed server-side. The resume and full report remain off-chain in the encrypted profile store. The existing EVM `ResumeRegistry` stores only the digest as `bytes32`; it does not store names, contact details, skill names, or resume/report contents. This uses the existing EVM/Solidity contract, not Hyperledger Fabric.

To enable public links and actual ledger checks, configure these backend environment variables before starting the server:

- `PUBLIC_BASE_URL`: the public HTTPS origin of this app, for example `https://credixa.example.org`. This must resolve from another device; localhost URLs are rejected for record creation.
- `EVM_RPC_URL`: an RPC endpoint for the same EVM network where the registry contract is deployed.
- `RESUME_REGISTRY_ADDRESS`: the deployed `ResumeRegistry.sol` contract address on that network.
- `APP_SECRET`: a stable, private secret for encrypted off-chain candidate records. Keep it unchanged and back it up with `backend/data/`.

The candidate also needs an injected EVM wallet (such as MetaMask) connected to the same network and enough native currency for transaction gas. The UI only says record integrity is verified after the wallet transaction is successful, the backend validates its receipt and `ResumeRegistered` event, and the public endpoint independently reads the record hash from the configured contract and matches it against the current saved record and resume digest. Network failures, missing records, or changed data are displayed as unverified/failed. Each candidate skill is marked verified only when its saved assessment reached 4/5 (80%) and the public record integrity check currently passes. The QR page publishes only the random ID, passing skill names, assessment date, and integrity outcome; it does not publish the resume or contact information. The PDF contains the normal resume content because the signed-in candidate explicitly downloads it, but unverified states remain labeled unverified.

The jsPDF and `qrcode-generator` browser bundles are installed locally and served same-origin; their PDF/QR generation does not rely on third-party CDN availability. The Ganache smoke test may print a µWS native-binary compatibility warning on Windows; Ganache falls back to its Node.js implementation and the test still exercises the deployed contract bytecode.

## Current boundaries

- The ATS score is an AI estimate based on common resume practices; real applicant tracking systems differ.
- Scanned PDFs need OCR before upload; this app extracts selectable PDF text.
- Resume edits are drafts. Review every factual detail before downloading or applying.
- Job results depend on search-index coverage and may be expired, duplicated, or incomplete; every result links to its source.
- This is a local MVP with account authentication and encrypted profile storage, not a hardened hosted service. The server binds to `127.0.0.1`. Before public deployment, use HTTPS, a production database, a managed secret store, robust rate limiting, email verification and password recovery, monitoring, backups, and an appropriate privacy/data-retention policy.


## Assessment and Verification

### Passing Criteria

- **80% Threshold**: Students must score at least 80% on each individual skill to mark it as verified
- **Per-Skill Scoring**: Each skill in the assessment is evaluated independently
- **Dynamic Question Distribution**: Questions are automatically distributed across all resume skills
- **No Partial Credit**: Skills scoring below 80% are marked as "not verified"

### Verification Workflow

1. **Upload Resume**: Student uploads resume to Resume Studio
2. **AI Analysis**: System extracts technical skills automatically
3. **Assessment**: Student takes proctored assessment covering all extracted skills
4. **Auto-Verification**: Skills meeting 80% threshold are automatically marked as verified
5. **Verification Record**: Create blockchain-anchored verification record with QR code
6. **Verified Resume**: Download PDF resume with "CREDIXA VERIFIED SKILLS" badge

### Environment Configuration

Copy `.env.example` to `.env` and configure at least one LLM provider API key:

```bash
# Required: Choose ONE provider
OPENAI_API_KEY=your_key_here
# OR
ANTHROPIC_API_KEY=your_key_here
# OR
GEMINI_API_KEY=your_key_here

# Optional: Blockchain verification
EVM_RPC_URL=http://127.0.0.1:8545
RESUME_REGISTRY_ADDRESS=0x...

# Optional: Public verification links
PUBLIC_BASE_URL=https://your-domain.com
```

