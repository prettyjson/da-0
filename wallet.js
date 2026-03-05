/**
 * Coinbase CDP Wallet Client
 * Handles auth (email OTP, Google OAuth) and embedded wallet on Base
 */

let cdpInitialized = false;
let currentCdpUser = null;

// Dynamic import since cdp-core is ESM
let cdpCore = null;

async function getCdpCore() {
    if (!cdpCore) {
        cdpCore = await import('@coinbase/cdp-core');
    }
    return cdpCore;
}

// Initialize CDP on page load
export async function initWallet() {
    try {
        const { initialize, isSignedIn, getCurrentUser } = await getCdpCore();

        await initialize({
            projectId: import.meta.env.VITE_CDP_PROJECT_ID || '',
            ethereum: {
                createOnLogin: 'smart', // ERC-4337 smart account for gas sponsorship
            },
        });
        cdpInitialized = true;

        // Check if user is already signed in (e.g., after OAuth redirect)
        const signedIn = await isSignedIn();
        if (signedIn) {
            currentCdpUser = await getCurrentUser();
            return { signedIn: true, user: formatUser(currentCdpUser) };
        }

        return { signedIn: false, user: null };
    } catch (err) {
        console.error('[WALLET] Init failed:', err);
        return { signedIn: false, user: null, error: err.message };
    }
}

// Email OTP login - Step 1: Send OTP
export async function sendEmailOTP(email) {
    const { signInWithEmail } = await getCdpCore();
    const result = await signInWithEmail({ email });
    return { flowId: result.flowId, message: result.message };
}

// Email OTP login - Step 2: Verify OTP
export async function verifyOTP(flowId, otp) {
    const { verifyEmailOTP, getCurrentUser } = await getCdpCore();
    const result = await verifyEmailOTP({ flowId, otp });
    currentCdpUser = await getCurrentUser();

    return {
        user: formatUser(currentCdpUser),
        isNewUser: result.isNewUser,
    };
}

// Google OAuth login (triggers page redirect)
export async function loginWithGoogle() {
    const { signInWithOAuth } = await getCdpCore();
    signInWithOAuth('google');
    // Page will redirect — on return, initWallet() picks up the session
}

// Sign out
export async function signOut() {
    const { signOut: cdpSignOut } = await getCdpCore();
    await cdpSignOut();
    currentCdpUser = null;
}

// Get current user
export function getWalletUser() {
    return currentCdpUser ? formatUser(currentCdpUser) : null;
}

// Get wallet address (smart account)
export function getWalletAddress() {
    if (!currentCdpUser) return null;
    const smartAccounts = currentCdpUser.evmSmartAccounts || [];
    if (smartAccounts.length > 0) return smartAccounts[0];
    const eoaAccounts = currentCdpUser.evmAccounts || [];
    return eoaAccounts[0] || null;
}

// Send a gasless user operation (e.g., USDC transfer for dues/donations)
export async function sendGaslessTransaction(calls) {
    const { sendUserOperation } = await getCdpCore();
    const smartAccount = (currentCdpUser.evmSmartAccounts || [])[0];
    if (!smartAccount) throw new Error('No smart account found');

    const result = await sendUserOperation({
        evmSmartAccount: smartAccount,
        network: 'base', // mainnet
        calls,
        useCdpPaymaster: true, // CDP sponsors gas on Base
    });

    return { userOpHash: result.userOperationHash };
}

// Format CDP user into our app's user shape
function formatUser(cdpUser) {
    if (!cdpUser) return null;
    const smartAccounts = cdpUser.evmSmartAccounts || [];
    const eoaAccounts = cdpUser.evmAccounts || [];
    return {
        cdpUserId: cdpUser.userId,
        email: cdpUser.email || null,
        walletAddress: smartAccounts[0] || eoaAccounts[0] || null,
        smartAccount: smartAccounts[0] || null,
        eoaAccount: eoaAccounts[0] || null,
    };
}

// Sync wallet user with our backend
export async function syncUserWithBackend(userData) {
    const res = await fetch('/api/auth/sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(userData),
    });
    return res.json();
}
