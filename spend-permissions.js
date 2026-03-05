/**
 * SpendPermissionManager integration for recurring dues
 * Adapted from auteur-film/src/lib/spend-permissions.ts
 *
 * Flow:
 * 1. User signs ONE EIP-712 SpendPermission (365-day validity, $10/month)
 * 2. Server stores signed permission in Supabase
 * 3. First charge: server calls approveWithSignature() on-chain, then spend()
 * 4. Subsequent charges: server calls spend() only (no user interaction)
 * 5. User can revoke() from settings at any time
 */

const { parseUnits, encodeFunctionData } = require('viem');

// Constants
const USDC_ADDRESS = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const USDC_DECIMALS = 6;
const SPEND_PERMISSION_MANAGER_ADDRESS = '0xf85210B21cC50302F477BA56686d2019dC9b67Ad';
const BASE_CHAIN_ID = 8453;
const DUES_AMOUNT = 10; // $10/month
const DUES_PERIOD = 30 * 24 * 60 * 60; // 30 days in seconds
const PERMISSION_DURATION = 365 * 24 * 60 * 60; // 365 days in seconds

// SpendPermissionManager ABI (subset)
const SPEND_PERMISSION_MANAGER_ABI = [
    {
        name: 'spend',
        type: 'function',
        stateMutability: 'nonpayable',
        inputs: [
            {
                name: 'spendPermission',
                type: 'tuple',
                components: [
                    { name: 'account', type: 'address' },
                    { name: 'spender', type: 'address' },
                    { name: 'token', type: 'address' },
                    { name: 'allowance', type: 'uint160' },
                    { name: 'period', type: 'uint48' },
                    { name: 'start', type: 'uint48' },
                    { name: 'end', type: 'uint48' },
                    { name: 'salt', type: 'uint256' },
                    { name: 'extraData', type: 'bytes' },
                ],
            },
            { name: 'value', type: 'uint160' },
        ],
        outputs: [],
    },
    {
        name: 'approveWithSignature',
        type: 'function',
        stateMutability: 'nonpayable',
        inputs: [
            {
                name: 'spendPermission',
                type: 'tuple',
                components: [
                    { name: 'account', type: 'address' },
                    { name: 'spender', type: 'address' },
                    { name: 'token', type: 'address' },
                    { name: 'allowance', type: 'uint160' },
                    { name: 'period', type: 'uint48' },
                    { name: 'start', type: 'uint48' },
                    { name: 'end', type: 'uint48' },
                    { name: 'salt', type: 'uint256' },
                    { name: 'extraData', type: 'bytes' },
                ],
            },
            { name: 'signature', type: 'bytes' },
        ],
        outputs: [],
    },
    {
        name: 'revoke',
        type: 'function',
        stateMutability: 'nonpayable',
        inputs: [
            {
                name: 'spendPermission',
                type: 'tuple',
                components: [
                    { name: 'account', type: 'address' },
                    { name: 'spender', type: 'address' },
                    { name: 'token', type: 'address' },
                    { name: 'allowance', type: 'uint160' },
                    { name: 'period', type: 'uint48' },
                    { name: 'start', type: 'uint48' },
                    { name: 'end', type: 'uint48' },
                    { name: 'salt', type: 'uint256' },
                    { name: 'extraData', type: 'bytes' },
                ],
            },
        ],
        outputs: [],
    },
];

// EIP-712 domain
const SPEND_PERMISSION_DOMAIN = {
    name: 'Spend Permission Manager',
    version: '1',
    chainId: BASE_CHAIN_ID,
    verifyingContract: SPEND_PERMISSION_MANAGER_ADDRESS,
};

// EIP-712 types
const SPEND_PERMISSION_TYPES = {
    SpendPermission: [
        { name: 'account', type: 'address' },
        { name: 'spender', type: 'address' },
        { name: 'token', type: 'address' },
        { name: 'allowance', type: 'uint160' },
        { name: 'period', type: 'uint48' },
        { name: 'start', type: 'uint48' },
        { name: 'end', type: 'uint48' },
        { name: 'salt', type: 'uint256' },
        { name: 'extraData', type: 'bytes' },
    ],
};

/**
 * Create a dues permission for a member
 * $10 allowance per 30-day period, valid for 365 days
 */
function createDuesPermission(memberWallet, treasuryWallet) {
    const now = Math.floor(Date.now() / 1000);
    return {
        account: memberWallet,
        spender: treasuryWallet,
        token: USDC_ADDRESS,
        allowance: parseUnits(DUES_AMOUNT.toString(), USDC_DECIMALS),
        period: DUES_PERIOD,
        start: now,
        end: now + PERMISSION_DURATION,
        salt: BigInt(now),
        extraData: '0x',
    };
}

/**
 * Calculate pro-rated dues for partial month
 * Returns amount in dollars
 */
function calculateProratedDues() {
    const now = new Date();
    const endOfMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0);
    const daysRemaining = endOfMonth.getDate() - now.getDate() + 1;
    const daysInMonth = endOfMonth.getDate();
    const prorated = (DUES_AMOUNT * daysRemaining) / daysInMonth;
    return Math.round(prorated * 100) / 100; // Round to cents
}

/**
 * Encode approveWithSignature calldata
 */
function encodeApproveWithSignature(permission, signature) {
    return encodeFunctionData({
        abi: SPEND_PERMISSION_MANAGER_ABI,
        functionName: 'approveWithSignature',
        args: [permission, signature],
    });
}

/**
 * Encode spend calldata
 */
function encodeSpend(permission, amount) {
    const amountRaw = parseUnits(amount.toString(), USDC_DECIMALS);
    return encodeFunctionData({
        abi: SPEND_PERMISSION_MANAGER_ABI,
        functionName: 'spend',
        args: [permission, amountRaw],
    });
}

/**
 * Serialize permission for DB storage (BigInt → string)
 */
function serializePermission(permission) {
    return {
        ...permission,
        allowance: permission.allowance.toString(),
        salt: permission.salt.toString(),
    };
}

/**
 * Deserialize permission from DB (string → BigInt)
 */
function deserializePermission(data) {
    return {
        ...data,
        allowance: BigInt(data.allowance),
        salt: BigInt(data.salt),
    };
}

module.exports = {
    USDC_ADDRESS,
    USDC_DECIMALS,
    SPEND_PERMISSION_MANAGER_ADDRESS,
    SPEND_PERMISSION_MANAGER_ABI,
    SPEND_PERMISSION_DOMAIN,
    SPEND_PERMISSION_TYPES,
    BASE_CHAIN_ID,
    DUES_AMOUNT,
    DUES_PERIOD,
    createDuesPermission,
    calculateProratedDues,
    encodeApproveWithSignature,
    encodeSpend,
    serializePermission,
    deserializePermission,
};
