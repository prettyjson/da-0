/**
 * Dues Collection Job
 * Runs daily (or on 1st of month) to auto-pull $10 USDC from active members
 *
 * Flow:
 * 1. Query all active members whose dues_paid_through < today
 * 2. For each, call spend() via CDP wallet to pull $10 USDC
 * 3. On success: update dues_paid_through, award 50 points, log payment
 * 4. On failure: mark member INACTIVE, log failure
 *
 * Usage: node jobs/collect-dues.js
 * Or call collectDues() from a cron scheduler
 */

require('dotenv').config();
const { getSupabase, isSupabaseEnabled } = require('../db/supabase');
const {
    SPEND_PERMISSION_MANAGER_ADDRESS,
    SPEND_PERMISSION_MANAGER_ABI,
    DUES_AMOUNT,
    calculateProratedDues,
    deserializePermission,
    encodeApproveWithSignature,
    encodeSpend,
} = require('../spend-permissions');

async function collectDues() {
    if (!isSupabaseEnabled()) {
        console.log('[DUES] Supabase not configured, skipping');
        return;
    }

    const supabase = getSupabase();
    const today = new Date().toISOString().slice(0, 10);

    console.log(`[DUES] Starting collection for ${today}`);

    // Get active members whose dues have lapsed
    const { data: members, error } = await supabase
        .from('users')
        .select('id, username, wallet_address, dues_paid_through, membership_status')
        .in('membership_status', ['active', 'trial'])
        .or(`dues_paid_through.is.null,dues_paid_through.lt.${today}`);

    if (error) {
        console.error('[DUES] Failed to query members:', error);
        return;
    }

    console.log(`[DUES] Found ${members.length} members needing dues collection`);

    let collected = 0;
    let failed = 0;

    for (const member of members) {
        // Skip members without wallets
        if (!member.wallet_address) {
            console.log(`[DUES] Skipping ${member.username} - no wallet`);
            continue;
        }

        // Get active spend permission
        const { data: permission } = await supabase
            .from('spend_permissions')
            .select('*')
            .eq('user_id', member.id)
            .is('revoked_at', null)
            .eq('is_active', true)
            .order('created_at', { ascending: false })
            .limit(1)
            .single();

        if (!permission) {
            console.log(`[DUES] ${member.username} - no active spend permission, marking INACTIVE`);
            await markInactive(supabase, member.id);
            failed++;
            continue;
        }

        try {
            // Determine amount (pro-rated for first payment)
            const isFirstPayment = !member.dues_paid_through;
            const amount = isFirstPayment ? calculateProratedDues() : DUES_AMOUNT;

            console.log(`[DUES] Collecting $${amount} from ${member.username}${isFirstPayment ? ' (pro-rated)' : ''}`);

            // TODO: Execute actual on-chain spend() via CDP Server Wallet
            // This requires CDP_API_KEY credentials to be configured
            //
            // const cdp = new CdpClient();
            // const serverAccount = await cdp.evm.getOrCreateAccount({ name: 'o-club-treasury' });
            // const baseAccount = await serverAccount.useNetwork('base');
            //
            // const signedPermission = deserializePermission(permission.permission_data);
            //
            // // First time: approveWithSignature
            // if (!permission.approved_on_chain) {
            //     const approveTx = await baseAccount.sendTransaction({
            //         transaction: {
            //             to: SPEND_PERMISSION_MANAGER_ADDRESS,
            //             data: encodeApproveWithSignature(signedPermission, signedPermission.signature),
            //             value: 0n,
            //         },
            //     });
            //     await baseAccount.waitForTransactionReceipt(approveTx);
            //     await supabase.from('spend_permissions').update({ approved_on_chain: true }).eq('id', permission.id);
            // }
            //
            // // Pull dues via spend()
            // const spendTx = await baseAccount.sendTransaction({
            //     transaction: {
            //         to: SPEND_PERMISSION_MANAGER_ADDRESS,
            //         data: encodeSpend(signedPermission, amount),
            //         value: 0n,
            //     },
            // });
            // await baseAccount.waitForTransactionReceipt(spendTx);

            // Calculate period end (end of current month)
            const endOfMonth = new Date();
            endOfMonth.setMonth(endOfMonth.getMonth() + 1, 0);
            const periodEnd = endOfMonth.toISOString().slice(0, 10);

            // Record payment
            await supabase.from('dues_payments').insert({
                user_id: member.id,
                amount,
                tx_hash: 'pending_cdp_setup', // Replace with actual tx hash
                period_start: today,
                period_end: periodEnd,
                is_prorated: isFirstPayment,
            });

            // Update dues_paid_through
            await supabase
                .from('users')
                .update({
                    dues_paid_through: periodEnd,
                    membership_status: 'active',
                })
                .eq('id', member.id);

            // Award points
            await supabase.from('points_ledger').insert({
                user_id: member.id,
                amount: 50, // Base points for dues (multiplier applied separately)
                reason: 'monthly_dues',
                metadata: { amount, period_end: periodEnd },
            });

            collected++;
            console.log(`[DUES] ${member.username} - collected $${amount}, paid through ${periodEnd}`);
        } catch (err) {
            console.error(`[DUES] ${member.username} - collection failed:`, err.message);
            await markInactive(supabase, member.id);
            failed++;
        }
    }

    // Update network stats
    const { count: activeCount } = await supabase
        .from('users')
        .select('id', { count: 'exact' })
        .eq('membership_status', 'active');

    const { count: totalCount } = await supabase
        .from('users')
        .select('id', { count: 'exact' });

    await supabase
        .from('network_stats')
        .update({
            active_members: activeCount,
            total_members: totalCount,
            updated_at: new Date().toISOString(),
        })
        .eq('id', 1);

    console.log(`[DUES] Complete. Collected: ${collected}, Failed: ${failed}`);
    return { collected, failed };
}

async function markInactive(supabase, userId) {
    await supabase
        .from('users')
        .update({ membership_status: 'inactive' })
        .eq('id', userId);

    // Increment churned count for this month
    await supabase.rpc('increment_churned');
}

// Run directly if called from CLI
if (require.main === module) {
    collectDues().then(() => process.exit(0)).catch(err => {
        console.error('[DUES] Fatal error:', err);
        process.exit(1);
    });
}

module.exports = { collectDues };
