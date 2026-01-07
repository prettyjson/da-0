const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');

const DB_PATH = path.join(__dirname, 'vetnet.db');

function initDatabase() {
    const db = new Database(DB_PATH);

    // Enable foreign keys
    db.pragma('foreign_keys = ON');

    // Read and execute schema
    const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
    db.exec(schema);

    // Check if data already exists
    const userCount = db.prepare('SELECT COUNT(*) as count FROM users').get();
    if (userCount.count > 0) {
        console.log('Database already seeded, skipping...');
        return db;
    }

    console.log('Seeding database with mockup data...');

    // Seed users from mockup
    const insertUser = db.prepare(`
        INSERT INTO users (username, email, rank_code, rank_title, unit, mos, service_years, deployment_history, clearance, stake_percentage, join_date, is_online, last_dividend)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const users = [
        { username: 'COL_HAYES_R', email: 'hayes.r@vetnet.mil', rank_code: 'O-6', rank_title: 'COLONEL', unit: '10TH_MTN', mos: '11A INFANTRY OFFICER', service_years: '1995-2020', deployment: 'IRAQ, AFGHANISTAN', clearance: 'TOP SECRET', stake: 8.7, join_date: '01JAN24', online: 1, dividend: 3721.45 },
        { username: 'MAJ_CHEN_L', email: 'chen.l@vetnet.mil', rank_code: 'O-4', rank_title: 'MAJOR', unit: 'RANGER', mos: '11A INFANTRY OFFICER', service_years: '2005-2022', deployment: 'AFGHANISTAN', clearance: 'SECRET', stake: 7.2, join_date: '15JAN24', online: 1, dividend: 3079.23 },
        { username: 'CSGT_RODRIGUEZ', email: 'rodriguez@vetnet.mil', rank_code: 'E-9', rank_title: 'COMMAND SERGEANT MAJOR', unit: 'MARSOC', mos: '0369 INFANTRY UNIT LEADER', service_years: '1998-2023', deployment: 'IRAQ, AFGHANISTAN, SYRIA', clearance: 'TOP SECRET', stake: 6.8, join_date: '20JAN24', online: 0, dividend: 2907.84 },
        { username: 'LCDR_PATEL_K', email: 'patel.k@vetnet.mil', rank_code: 'O-4', rank_title: 'LIEUTENANT COMMANDER', unit: 'SEAL_7', mos: '1130 SPECIAL WARFARE', service_years: '2008-2023', deployment: 'CLASSIFIED', clearance: 'TOP SECRET/SCI', stake: 5.9, join_date: '01FEB24', online: 1, dividend: 2522.67 },
        { username: 'CPT_WILLIAMS_M', email: 'williams.m@vetnet.mil', rank_code: 'O-3', rank_title: 'CAPTAIN', unit: '82ND_ABN', mos: '11A INFANTRY OFFICER', service_years: '2012-2022', deployment: 'AFGHANISTAN', clearance: 'SECRET', stake: 5.4, join_date: '10FEB24', online: 1, dividend: 2308.12 },
        { username: 'SSGT_JOHNSON_T', email: 'johnson.t@vetnet.mil', rank_code: 'E-6', rank_title: 'STAFF SERGEANT', unit: 'DELTA', mos: '18B SPECIAL FORCES WEAPONS', service_years: '2010-2021', deployment: 'CLASSIFIED', clearance: 'TOP SECRET', stake: 4.9, join_date: '15FEB24', online: 0, dividend: 2094.56 },
        { username: 'LT_ANDERSON_C', email: 'anderson.c@vetnet.mil', rank_code: 'O-2', rank_title: 'LIEUTENANT', unit: '101ST_ABN', mos: '11A INFANTRY OFFICER', service_years: '2018-2023', deployment: 'IRAQ', clearance: 'SECRET', stake: 4.7, join_date: '20FEB24', online: 1, dividend: 2009.34 },
        { username: 'SGT_MARTINEZ_J', email: 'martinez.j@vetnet.mil', rank_code: 'E-5', rank_title: 'SERGEANT', unit: '82ND_ABN', mos: '11B INFANTRYMAN', service_years: '2018-2023', deployment: 'AFGHANISTAN (2019-2020)', clearance: 'SECRET', stake: 2.3, join_date: '15MAR24', online: 1, dividend: 847.12 },
        { username: 'SGT_THOMPSON_A', email: 'thompson.a@vetnet.mil', rank_code: 'E-5', rank_title: 'SERGEANT', unit: '3RD_ID', mos: '11B INFANTRYMAN', service_years: '2016-2022', deployment: 'IRAQ', clearance: 'SECRET', stake: 1.8, join_date: '01APR24', online: 1, dividend: 769.45 },
        { username: 'CPL_MARTINEZ_R', email: 'martinez.r@vetnet.mil', rank_code: 'E-4', rank_title: 'CORPORAL', unit: '1ST_MAR', mos: '0311 RIFLEMAN', service_years: '2019-2023', deployment: 'NONE', clearance: 'SECRET', stake: 1.2, join_date: '15APR24', online: 1, dividend: 512.97 },
        { username: 'SFC_RODRIGUEZ_J', email: 'rodriguez.j@vetnet.mil', rank_code: 'E-7', rank_title: 'SERGEANT FIRST CLASS', unit: '75TH_RGR', mos: '11B INFANTRYMAN', service_years: '2005-2020', deployment: 'AFGHANISTAN, IRAQ', clearance: 'SECRET', stake: 3.1, join_date: '01MAR24', online: 1, dividend: 1325.12 },
        { username: 'CPL_DAVIS_M', email: 'davis.m@vetnet.mil', rank_code: 'E-4', rank_title: 'CORPORAL', unit: '2ND_MAR', mos: '0311 RIFLEMAN', service_years: '2020-2024', deployment: 'NONE', clearance: 'SECRET', stake: 0.8, join_date: '01MAY24', online: 0, dividend: 341.98 },
        { username: 'LTC_BLACKWOOD', email: 'blackwood@vetnet.mil', rank_code: 'O-5', rank_title: 'LIEUTENANT COLONEL', unit: 'INTEL', mos: '35D MI OFFICER', service_years: '2000-2022', deployment: 'CLASSIFIED', clearance: 'TOP SECRET/SCI', stake: 4.2, join_date: '05JAN24', online: 1, dividend: 1795.23 },
        { username: 'MAJ_CRYPTO_01', email: 'crypto01@vetnet.mil', rank_code: 'O-4', rank_title: 'MAJOR', unit: 'CYBERCOM', mos: '17A CYBER OFFICER', service_years: '2008-2023', deployment: 'NONE', clearance: 'TOP SECRET/SCI', stake: 3.5, join_date: '10JAN24', online: 1, dividend: 1496.12 },
        { username: 'CPT_CYBER_07', email: 'cyber07@vetnet.mil', rank_code: 'O-3', rank_title: 'CAPTAIN', unit: 'CYBERCOM', mos: '17A CYBER OFFICER', service_years: '2015-2024', deployment: 'NONE', clearance: 'TOP SECRET', stake: 2.1, join_date: '20JAN24', online: 1, dividend: 897.45 },
        { username: 'SSGT_CHEN_K', email: 'chen.k@vetnet.mil', rank_code: 'E-6', rank_title: 'STAFF SERGEANT', unit: '82ND_ABN', mos: '11B INFANTRYMAN', service_years: '2012-2022', deployment: 'AFGHANISTAN', clearance: 'SECRET', stake: 2.0, join_date: '01APR24', online: 1, dividend: 854.89 }
    ];

    users.forEach(u => {
        insertUser.run(u.username, u.email, u.rank_code, u.rank_title, u.unit, u.mos, u.service_years, u.deployment, u.clearance, u.stake, u.join_date, u.online, u.dividend);
    });

    // Seed badges
    const insertBadge = db.prepare('INSERT INTO user_badges (user_id, badge_name) VALUES (?, ?)');
    const badgeData = [
        { username: 'SGT_MARTINEZ_J', badges: ['COMBAT_INFANTRYMAN', 'EXPERT_MARKSMAN', 'AIRBORNE_WINGS', 'ARMY_COMMENDATION', 'GOOD_CONDUCT', 'AFGHANISTAN_CAMPAIGN', 'OVERSEAS_SERVICE'] },
        { username: 'COL_HAYES_R', badges: ['COMBAT_INFANTRYMAN', 'RANGER_TAB', 'AIRBORNE_WINGS', 'BRONZE_STAR', 'LEGION_OF_MERIT', 'MERITORIOUS_SERVICE'] },
        { username: 'MAJ_CHEN_L', badges: ['RANGER_TAB', 'COMBAT_INFANTRYMAN', 'AIRBORNE_WINGS', 'BRONZE_STAR', 'PURPLE_HEART'] },
        { username: 'LCDR_PATEL_K', badges: ['TRIDENT', 'BRONZE_STAR', 'NAVY_COMMENDATION', 'COMBAT_ACTION'] },
        { username: 'SSGT_JOHNSON_T', badges: ['SPECIAL_FORCES_TAB', 'COMBAT_INFANTRYMAN', 'BRONZE_STAR', 'PURPLE_HEART'] }
    ];

    badgeData.forEach(bd => {
        const user = db.prepare('SELECT id FROM users WHERE username = ?').get(bd.username);
        if (user) {
            bd.badges.forEach(badge => insertBadge.run(user.id, badge));
        }
    });

    // Seed treasury
    db.prepare(`
        INSERT INTO treasury (id, balance, member_dues, investments, pending, monthly_spending, operations_spending, member_services_spending, admin_spending)
        VALUES (1, 24891203.47, 18234901, 6456302, 200000, 1847392.12, 892341, 634821, 320230)
    `).run();

    // Seed network stats
    db.prepare(`
        INSERT INTO network_stats (id, total_members, annual_income, active_nodes, uptime_percentage)
        VALUES (1, 1729314, 157651814346, 136794270, 99.97)
    `).run();

    // Seed proposals
    const insertProposal = db.prepare(`
        INSERT INTO proposals (title, description, initiated_date, closes_date, quorum_required, status, yes_count, no_count)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    insertProposal.run('Network Expansion to Coast Guard Veterans', 'Proposal to expand VETNET membership eligibility to include verified Coast Guard veterans.', '08AUG25', '15AUG25', 67, 'active', 1349, 381);
    insertProposal.run('Monthly Member Benefit Increase', 'Proposal to increase monthly member benefits by 15% across all tiers.', '05AUG25', '12AUG25', 67, 'active', 821, 1003);
    insertProposal.run('Treasury Investment Strategy Change', 'Proposal to diversify treasury investments into additional asset classes.', '03AUG25', '10AUG25', 67, 'active', 1567, 193);
    insertProposal.run('Network Security Upgrade', 'Implement enhanced encryption and security protocols across all network communications.', '25JUL25', '01AUG25', 67, 'passed', 1623, 160);
    insertProposal.run('Quarterly Dividend Distribution', 'Approve Q2 dividend distribution to all verified members based on stake percentage.', '21JUL25', '28JUL25', 67, 'passed', 1891, 283);

    // Seed user votes
    const martinez = db.prepare('SELECT id FROM users WHERE username = ?').get('SGT_MARTINEZ_J');
    if (martinez) {
        db.prepare('INSERT INTO user_votes (user_id, proposal_id, vote, weight) VALUES (?, ?, ?, ?)').run(martinez.id, 2, 'yes', 2.3);
        db.prepare('INSERT INTO user_votes (user_id, proposal_id, vote, weight) VALUES (?, ?, ?, ?)').run(martinez.id, 4, 'yes', 2.3);
        db.prepare('INSERT INTO user_votes (user_id, proposal_id, vote, weight) VALUES (?, ?, ?, ?)').run(martinez.id, 5, 'yes', 2.3);
    }

    // Seed channels
    const insertChannel = db.prepare('INSERT INTO channels (name, type, is_private, member_count) VALUES (?, ?, ?, ?)');
    insertChannel.run('GENERAL', 'channel', 0, 1847);
    insertChannel.run('OFFICERS_CLUB', 'channel', 0, 89);
    insertChannel.run('NCO_CLUB', 'channel', 0, 342);
    insertChannel.run('INTEL_BRIEF', 'channel', 1, 156);

    // Seed DM channels
    insertChannel.run('DM_COL_HAYES_R', 'dm', 1, 2);
    insertChannel.run('DM_CPT_WILLIAMS_M', 'dm', 1, 2);
    insertChannel.run('DM_SSGT_CHEN_K', 'dm', 1, 2);

    // Seed messages
    const insertMessage = db.prepare('INSERT INTO messages (channel_id, user_id, content, timestamp) VALUES (?, ?, ?, ?)');

    // General channel messages
    const generalMessages = [
        { user: 'SGT_THOMPSON_A', content: 'Anyone else having issues with the new benefits portal?', time: '2025-08-11T08:47:00Z' },
        { user: 'LCDR_PATEL_K', content: '@SGT_THOMPSON_A Try clearing your browser cache, worked for me', time: '2025-08-11T08:49:00Z' },
        { user: 'CPL_MARTINEZ_R', content: 'Reminder: Network vote on Coast Guard expansion closes in 4 days', time: '2025-08-11T08:51:00Z' },
        { user: 'MAJ_CHEN_L', content: 'Good morning everyone. Treasury report will be posted after the 1000Z briefing', time: '2025-08-11T08:53:00Z' },
        { user: 'SFC_RODRIGUEZ_J', content: 'New member orientation tonight at 1900Z. All welcome to join and help', time: '2025-08-11T08:55:00Z' },
        { user: 'LT_ANDERSON_C', content: 'Can confirm benefits portal is working now. Thanks for the quick fix team', time: '2025-08-11T08:57:00Z' }
    ];

    generalMessages.forEach(msg => {
        const user = db.prepare('SELECT id FROM users WHERE username = ?').get(msg.user);
        if (user) {
            insertMessage.run(1, user.id, msg.content, msg.time);
        }
    });

    // Officers club messages
    const officersMessages = [
        { user: 'COL_HAYES_R', content: 'Morning briefing notes: Network expansion vote trending positive', time: '2025-08-11T08:32:00Z' },
        { user: 'MAJ_CHEN_L', content: 'Treasury allocations look good for Q3. Should we brief the members?', time: '2025-08-11T08:34:00Z' },
        { user: 'CPT_WILLIAMS_M', content: 'Agreed. Transparency builds trust. Full report recommended', time: '2025-08-11T08:36:00Z' },
        { user: 'LT_ANDERSON_C', content: 'New member onboarding process needs streamlining', time: '2025-08-11T08:40:00Z' }
    ];

    officersMessages.forEach(msg => {
        const user = db.prepare('SELECT id FROM users WHERE username = ?').get(msg.user);
        if (user) {
            insertMessage.run(2, user.id, msg.content, msg.time);
        }
    });

    // NCO Club messages
    const ncoMessages = [
        { user: 'SFC_RODRIGUEZ_J', content: 'Weekly NCO meeting tonight. Agenda includes mentorship program', time: '2025-08-11T08:25:00Z' },
        { user: 'SSGT_JOHNSON_T', content: 'Junior enlisted are asking about career transition resources', time: '2025-08-11T08:28:00Z' },
        { user: 'SGT_MARTINEZ_J', content: 'Good point. Maybe we need a dedicated channel for career advice', time: '2025-08-11T08:30:00Z' },
        { user: 'CPL_DAVIS_M', content: "I can help with resume reviews. Did 50+ last month for transition", time: '2025-08-11T08:35:00Z' }
    ];

    ncoMessages.forEach(msg => {
        const user = db.prepare('SELECT id FROM users WHERE username = ?').get(msg.user);
        if (user) {
            insertMessage.run(3, user.id, msg.content, msg.time);
        }
    });

    // Intel brief messages
    const intelMessages = [
        { user: 'LTC_BLACKWOOD', content: '=== DAILY INTELLIGENCE BRIEF ===', time: '2025-08-11T08:00:00Z' },
        { user: 'LTC_BLACKWOOD', content: 'Network security: No threats detected in last 24h', time: '2025-08-11T08:01:00Z' },
        { user: 'MAJ_CRYPTO_01', content: 'Member verification backlog cleared. 23 new authentications', time: '2025-08-11T08:03:00Z' },
        { user: 'CPT_CYBER_07', content: 'Monitoring suspicious login attempts. Patterns suggest automated probing', time: '2025-08-11T08:05:00Z' }
    ];

    intelMessages.forEach(msg => {
        const user = db.prepare('SELECT id FROM users WHERE username = ?').get(msg.user);
        if (user) {
            insertMessage.run(4, user.id, msg.content, msg.time);
        }
    });

    // DM messages
    const hayesDMs = [
        { user: 'COL_HAYES_R', content: 'Martinez, good work on the quarterly report analysis', time: '2025-08-11T07:45:00Z' },
        { user: 'SGT_MARTINEZ_J', content: 'Thank you sir. Happy to contribute to network operations', time: '2025-08-11T07:46:00Z' },
        { user: 'COL_HAYES_R', content: 'Consider applying for the finance committee. Your insights are valuable', time: '2025-08-11T07:48:00Z' }
    ];

    hayesDMs.forEach(msg => {
        const user = db.prepare('SELECT id FROM users WHERE username = ?').get(msg.user);
        if (user) {
            insertMessage.run(5, user.id, msg.content, msg.time);
        }
    });

    const williamsDMs = [
        { user: 'SGT_MARTINEZ_J', content: "Morning Captain. Ready for today's briefing prep?", time: '2025-08-11T07:30:00Z' },
        { user: 'CPT_WILLIAMS_M', content: 'Absolutely. Can you pull the member satisfaction metrics?', time: '2025-08-11T07:32:00Z' },
        { user: 'SGT_MARTINEZ_J', content: 'Already compiled. Sending via encrypted channel now', time: '2025-08-11T07:34:00Z' }
    ];

    williamsDMs.forEach(msg => {
        const user = db.prepare('SELECT id FROM users WHERE username = ?').get(msg.user);
        if (user) {
            insertMessage.run(6, user.id, msg.content, msg.time);
        }
    });

    const chenDMs = [
        { user: 'SSGT_CHEN_K', content: 'Hey Martinez, you free to help with new member orientation prep?', time: '2025-08-11T07:20:00Z' },
        { user: 'SGT_MARTINEZ_J', content: 'Sure thing. What do you need?', time: '2025-08-11T07:22:00Z' },
        { user: 'SSGT_CHEN_K', content: 'Presentation slides for DD214 verification process', time: '2025-08-11T07:24:00Z' },
        { user: 'SGT_MARTINEZ_J', content: "I'll have those ready by 1200Z. Standard brief format?", time: '2025-08-11T07:26:00Z' },
        { user: 'SSGT_CHEN_K', content: "Perfect. Thanks, you're the best", time: '2025-08-11T07:28:00Z' }
    ];

    chenDMs.forEach(msg => {
        const user = db.prepare('SELECT id FROM users WHERE username = ?').get(msg.user);
        if (user) {
            insertMessage.run(7, user.id, msg.content, msg.time);
        }
    });

    // Seed stages
    const insertStage = db.prepare('INSERT INTO stages (name, is_live, listener_count) VALUES (?, ?, ?)');
    insertStage.run('MILITARY_LEADERSHIP', 1, 596);
    insertStage.run('FRIDAY_DEBRIEF', 1, 218);
    insertStage.run('WELCOME_LOUNGE', 0, 38);
    insertStage.run('NCO_CLUB', 0, 0);

    console.log('Database seeded successfully!');
    return db;
}

function getDatabase() {
    return new Database(DB_PATH);
}

module.exports = { initDatabase, getDatabase, DB_PATH };
