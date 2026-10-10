/* pos.watch — Innova (INN) staking calculator
 *
 * Every constant below is read out of the Innova wallet source, not from
 * marketing copy. Source file + line is cited on each one so it can be
 * re-checked against github.com/innova-foundation/innova when consensus moves.
 *
 * Three views over two reward models:
 *
 *   pos      what mainnet enforces today (v4.3.9.x rules). A 6%/year mint on
 *            coin-age, of which the staker keeps 35% and a collateral node
 *            takes 65% in a separate output on the same coinstake.
 *
 *   idag     what v5.0.0.0 ships but mainnet is not yet enforcing. PoS block
 *            production is abolished; stakers cast a finality vote each epoch
 *            and are paid on the same 6% curve with no collateral node cut.
 *
 *   compare  both at once, because the interesting fact is the gap between
 *            them — losing the 65% cut nearly triples the staker's take.
 */
(function () {
  'use strict';

  // ---------------------------------------------------------------- chain --

  var CHAIN = {
    name: 'Innova',
    ticker: 'INN',
    coin: 100000000,            // COIN                          util.h:46

    // Proof of stake, as enforced on mainnet today
    coinYearReward: 0.06,       // COIN_YEAR_REWARD = 0.06*COIN  main.h:115
    nodeShare: 0.65,            // GetCollateralnodePayment      main.cpp:10009
    stakerShare: 0.35,          // remainder to the staker       wallet.cpp:5364
    targetSpacing: 15,          // nTargetSpacing (seconds)      main.cpp:185
    stakeMinAgeHours: 10,       // nStakeMinAge = 10*60*60       main.cpp:186
    maturityBlocks: 75,         // wallet-displayed maturity     main.cpp:2145
    nodeCollateral: 25000,      // GetMNCollateral()             main.h:529
    maxSupply: 18000000,        // MAX_MONEY                     main.h:114

    /* PoW subsidy ladder, main.cpp:2837-2996. Derived from height rather than
     * fetched — it only feeds the collateral node estimate. */
    powLadder: [
      [8000000, 0.25], [8250000, 0.20], [8500000, 0.15], [8750000, 0.10],
      [9000000, 0.05], [9250000, 0.01], [9500000, 0.05], [9750000, 0.10],
      [10000000, 0.20]
    ],
    powTail: 0.0001,

    // IDAG finality voting, as shipped in v5.0.0.0 (dormant on mainnet)
    dag: {
      epochBlocks: 300,         // post-DAG epoch length         finality.cpp
      blockSpacing: 1,          // GetTargetSpacingForHeight     main.h:490
      maxUtxosPerVote: 8,       // one vote per wallet per epoch
      forkHeight: 7950000       // FORK_HEIGHT_DAG               main.h:290
    },

    /* Observed spacing runs longer than the 15s target — a 385-block sample on
     * 2026-09-05 measured 17.6s. The node estimate is quoted as a range across
     * both, because that spread moves the answer by over ten points. */
    spacingRange: [15, 18],
    powBlockShare: 0.93,        // sampled; PoS blocks are a clear minority

    // Used when the explorer is unreachable. Snapshot: 2026-09-05.
    fallback: {
      height: 8018215,
      supply: 11026647,
      nodes: 15,
      diff: 0.04489108
    }
  };

  var SECONDS_PER_DAY = 86400;
  var DAYS_PER_YEAR = 365;
  var MAX_INPUT = 1e15;

  // ------------------------------------------------------------ reward math --

  /* Daily restaking. Rewards land back in the staking output, so they really
   * do compound; this is the standard APR -> APY conversion at n = 365. */
  function toApy(apr) {
    return Math.pow(1 + apr / DAYS_PER_YEAR, DAYS_PER_YEAR) - 1;
  }

  /* Proof of stake (current mainnet).
   *
   * The mint is 6%/year on coin-age. Because it is paid on accumulated
   * coin-age and the deployed rules cap nothing, the annual total does not
   * depend on how often you win a block — winning rarely just means each win
   * carries proportionally more coin-age. So win probability drives variance
   * and timing, never the yearly figure. That is why no network weight term
   * appears here.
   */
  function computePos(balance, compound) {
    var stakerRate = CHAIN.coinYearReward * CHAIN.stakerShare;   // 2.10%
    var rate = compound ? toApy(stakerRate) : stakerRate;

    var staker = balance * rate;
    // The node's cut scales with the same mint the staker's share comes from,
    // so derive it from the staker figure rather than re-deriving from balance.
    var gross = staker / CHAIN.stakerShare;
    var node = gross - staker;

    return {
      mode: 'pos',
      yourYearly: staker,
      effectiveRate: rate,
      gross: gross,
      node: node,
      rows: [
        { who: 'You (staker)',    share: CHAIN.stakerShare, yearly: staker, highlight: true },
        { who: 'Collateral node', share: CHAIN.nodeShare,   yearly: node },
        { who: 'Block mint',      share: 1,                 yearly: gross, total: true }
      ]
    };
  }

  /* IDAG finality voting (v5.0.0.0, not live).
   *
   * Reproduces the integer arithmetic exactly, because the truncation is not
   * a rounding detail — it is the whole story. From finality.cpp:
   *
   *   coinAge = floor(floor(weightSat * epochInterval / COIN) / 86400)
   *   reward  = floor(coinAge * COIN_YEAR_REWARD / 365)
   *
   * With a 300-second epoch that inner term collapses to floor(balance / 288),
   * so a stake under 288 INN votes but is paid nothing at all, and above it
   * the payout steps in 288 INN quanta. BigInt keeps this exact: a balance in
   * the millions overflows float64 once multiplied out to satoshi-seconds.
   */
  function computeIdag(balance, compound) {
    var epochInterval = CHAIN.dag.epochBlocks * CHAIN.dag.blockSpacing;
    var epochsPerYear = (DAYS_PER_YEAR * SECONDS_PER_DAY) / epochInterval;

    var COIN = BigInt(CHAIN.coin);
    var weightSat = toSatoshi(balance);
    var coinDays = (weightSat * BigInt(epochInterval) / COIN) / BigInt(SECONDS_PER_DAY);
    var rewardSat = coinDays * BigInt(Math.round(CHAIN.coinYearReward * CHAIN.coin))
                             / BigInt(DAYS_PER_YEAR);

    var perEpoch = Number(rewardSat) / CHAIN.coin;
    var simple = perEpoch * epochsPerYear;
    var baseRate = balance > 0 ? simple / balance : 0;

    var rate = compound ? toApy(baseRate) : baseRate;
    var yearly = balance * rate;

    var quantum = SECONDS_PER_DAY / epochInterval;   // 288 INN at a 300s epoch

    return {
      mode: 'idag',
      yourYearly: yearly,
      effectiveRate: rate,
      gross: yearly,
      node: 0,
      epoch: {
        interval: epochInterval,
        perYear: epochsPerYear,
        coinDays: Number(coinDays),
        perEpoch: perEpoch,
        quantum: quantum,
        belowFloor: balance > 0 && coinDays === BigInt(0),
        remainder: balance > 0 ? (quantum - (balance % quantum)) % quantum : 0
      },
      rows: [
        { who: 'You (staker)',    share: 1, yearly: yearly, highlight: true },
        { who: 'Collateral node', share: 0, yearly: 0 },
        { who: 'Vote mint',       share: 1, yearly: yearly, total: true }
      ]
    };
  }

  function compute(balance, mode, compound) {
    return mode === 'idag' ? computeIdag(balance, compound)
                           : computePos(balance, compound);
  }

  /* Collateral node yield. This one is a DERIVATION — Innova publishes no node
   * rate — so it is quoted as a range across the observed block-spacing spread
   * and labelled as an estimate everywhere it appears. It is dominated by two
   * volatile inputs: the live node count and the PoW/PoS block mix. */
  function computeNode(height, nodes) {
    if (!nodes || nodes <= 0) return null;

    var subsidy = powSubsidy(height);
    var out = CHAIN.spacingRange.map(function (spacing) {
      var blocksPerDay = SECONDS_PER_DAY / spacing;
      var poolPerDay = blocksPerDay * CHAIN.powBlockShare * subsidy * CHAIN.nodeShare;
      var perNodeDay = poolPerDay / nodes;
      return {
        spacing: spacing,
        perDay: perNodeDay,
        perYear: perNodeDay * DAYS_PER_YEAR,
        apr: (perNodeDay * DAYS_PER_YEAR) / CHAIN.nodeCollateral
      };
    });

    // spacingRange is [fast, slow]; faster blocks pay more, so out[0] is the high end.
    return { subsidy: subsidy, nodes: nodes, high: out[0], low: out[1] };
  }

  function powSubsidy(height) {
    for (var i = 0; i < CHAIN.powLadder.length; i++) {
      if (height <= CHAIN.powLadder[i][0]) return CHAIN.powLadder[i][1];
    }
    return CHAIN.powTail;
  }

  // -------------------------------------------------------------- format --

  function fmt(n, dp) {
    if (!isFinite(n)) return '—';
    if (dp === undefined) dp = 8;
    // toFixed switches to exponential at 1e21, which the separator regex would mangle.
    if (Math.abs(n) >= 1e21) return n.toExponential(4);
    var s = n.toFixed(dp);
    var parts = s.split('.');
    parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    return parts.join('.');
  }

  function fmtInt(n) {
    if (n === null || n === undefined || !isFinite(n)) return '—';
    return Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  }

  /* A gap of 0.004 INN is not "0.00" — that would read as "add nothing". */
  function gap(n) {
    return n > 0 && n < 0.01 ? '<0.01' : fmt(n, 2);
  }

  function pct(x, dp) {
    if (!isFinite(x)) return '—';
    return (x * 100).toFixed(dp === undefined ? 2 : dp) + '%';
  }

  /* Balance -> satoshi as an exact BigInt.
   * Math.round(balance * 1e8) is unsafe past 2^53 (about 90M INN), so expand
   * the decimal instead: toFixed(8) is an exact expansion of the double. */
  function toSatoshi(n) {
    if (!isFinite(n) || n <= 0) return BigInt(0);
    if (n > MAX_INPUT) n = MAX_INPUT;
    return BigInt(n.toFixed(8).replace('.', ''));
  }

  function parseAmount(raw) {
    var n = parseFloat(String(raw).replace(/,/g, ''));
    if (!isFinite(n) || n <= 0) return 0;
    // Clamp here rather than deeper in, so the balance and the reward derived
    // from it stay consistent and the effective rate does not read as 0%.
    return n > MAX_INPUT ? MAX_INPUT : n;
  }

  /* Digits and a single dot, capped at 8 decimals — INN's precision — and at
   * the field's maxlength, which only binds typing, not a value set from JS.
   * Keep only the FIRST dot: one regex pass drops just one of several. */
  function cleanAmount(raw) {
    var v = String(raw).replace(/[^0-9.]/g, '');
    var dot = v.indexOf('.');
    if (dot !== -1) v = v.slice(0, dot + 1) + v.slice(dot + 1).replace(/\./g, '');
    return v.replace(/(\.\d{8})\d+/, '$1').slice(0, 18);
  }

  // ----------------------------------------------------------------- dom --

  var $ = function (id) { return document.getElementById(id); };
  var root = document.documentElement;

  var els = {
    amount: $('amount'), amountHint: $('amount-hint'), compound: $('compound'),
    copyLink: $('copy-link'), toast: $('toast'),
    tiles: $('tiles'),
    daily: $('out-daily'), monthly: $('out-monthly'),
    yearly: $('out-yearly'), apr: $('out-apr'), aprNote: $('out-apr-note'),
    splitPanel: $('split-panel'), splitBody: $('split-body'),
    splitTitle: $('split-title'), splitNote: $('split-note'),
    comparePanel: $('compare-panel'), compareGrid: $('compare-grid'),
    compareVerdict: $('compare-verdict'), compareNote: $('compare-note'),
    epochPanel: $('epoch-panel'), epochKv: $('epoch-kv'), epochNote: $('epoch-note'),
    nodeKv: $('node-kv'), nodeNote: $('node-note'),
    idagNotice: $('idag-notice'),
    heroLead: $('hero-lead'),
    hsHeight: $('hs-height'), hsSupply: $('hs-supply'),
    hsNodes: $('hs-nodes'), hsRate: $('hs-rate'),
    netKv: $('net-kv'), netDot: $('net-dot'), netStatus: $('net-status'),
    rulesKv: $('rules-kv'), rulesNote: $('rules-note'),
    caveats: $('caveats'),
    skinBtn: $('skin-toggle'), skinLabel: document.querySelector('.skin-btn-label')
  };

  function kv(dl, pairs) {
    dl.innerHTML = '';
    pairs.forEach(function (p) {
      if (!p) return;
      var dt = document.createElement('dt');
      dt.textContent = p[0];
      var dd = document.createElement('dd');
      dd.textContent = p[1];
      if (p[2]) dd.className = p[2];
      dl.appendChild(dt);
      dl.appendChild(dd);
    });
  }

  function list(ul, items) {
    ul.innerHTML = '';
    items.forEach(function (t) {
      if (!t) return;
      var li = document.createElement('li');
      li.innerHTML = t;
      ul.appendChild(li);
    });
  }

  // --------------------------------------------------------------- render --

  var net = null;   // live chain data once it lands

  function render() {
    var mode = root.dataset.mode;
    var balance = parseAmount(els.amount.value);
    var compound = !!els.compound.checked;

    var compare = mode === 'compare';
    els.comparePanel.hidden = !compare;
    els.tiles.hidden = compare;
    els.splitPanel.hidden = compare;
    els.epochPanel.hidden = compare || mode !== 'idag';
    els.idagNotice.hidden = mode === 'pos';

    if (compare) renderCompare(balance, compound);
    else renderSingle(balance, mode, compound);

    renderRules(mode);
    renderCaveats(mode, compound);
    syncUrl(balance, mode, compound);
  }

  function renderSingle(balance, mode, compound) {
    var r = compute(balance, mode, compound);

    els.daily.textContent = fmt(r.yourYearly / DAYS_PER_YEAR);
    els.monthly.textContent = fmt(r.yourYearly / 12);
    els.yearly.textContent = fmt(r.yourYearly);
    els.apr.textContent = balance > 0 ? pct(r.effectiveRate) : '—';
    els.aprNote.textContent = compound ? 'net APY, compounded' : 'net APR';

    els.splitBody.innerHTML = '';
    r.rows.forEach(function (row) {
      var tr = document.createElement('tr');
      if (row.highlight) tr.className = 'row-you';
      if (row.total) tr.className = 'row-total';
      [row.who, pct(row.share, 0),
       fmt(row.yearly / DAYS_PER_YEAR), fmt(row.yearly / 12), fmt(row.yearly)
      ].forEach(function (c, i) {
        var td = document.createElement('td');
        td.textContent = c;
        if (i >= 2) td.className = 'num';
        tr.appendChild(td);
      });
      els.splitBody.appendChild(tr);
    });

    if (mode === 'pos') {
      els.splitTitle.textContent = 'reward split';
      els.heroLead.textContent =
        'Innova mints ' + pct(CHAIN.coinYearReward) + ' a year on the coin-age your stake ' +
        'consumes. A collateral node takes ' + pct(CHAIN.nodeShare, 0) + ' of that mint in a ' +
        'separate output, so you keep ' + pct(CHAIN.stakerShare, 0) + ' — an effective ' +
        pct(CHAIN.coinYearReward * CHAIN.stakerShare) + ' on your balance.';
      els.splitNote.innerHTML =
        'The ' + pct(CHAIN.nodeShare, 0) + ' cut is applied to the <em>reward only</em>, never ' +
        'to your staked principal, and it leaves as a separate output on the same coinstake ' +
        'transaction. If no collateral node is eligible when your block lands, that share is ' +
        'burned rather than paid to you.';
      els.amountHint.textContent =
        'Rewards fold back into your staking output, so the balance compounds as it restakes.';

    } else {
      els.splitTitle.textContent = 'reward split — no node cut';
      els.heroLead.textContent =
        'After the IDAG fork there are no PoS blocks. Stakers instead cast one finality vote ' +
        'per ' + CHAIN.dag.epochBlocks + '-block epoch and are paid on the same ' +
        pct(CHAIN.coinYearReward) + ' curve — but with no collateral node cut, so the whole ' +
        'mint is yours.';
      els.splitNote.innerHTML =
        'Finality-vote rewards are minted straight to you on top of the PoW subsidy, with no ' +
        'collateral node share. Collateral nodes still exist post-fork — still ' +
        fmtInt(CHAIN.nodeCollateral) + ' INN, still ' + pct(CHAIN.nodeShare, 0) + ' of block ' +
        'value — they just no longer take a cut of staking rewards.';
      renderEpoch(r.epoch, balance);
    }
  }

  function renderEpoch(e, balance) {
    kv(els.epochKv, [
      ['Epoch length', CHAIN.dag.epochBlocks + ' blocks · ' + e.interval + 's at ' +
                       CHAIN.dag.blockSpacing + 's/block'],
      ['Epochs per year', fmtInt(e.perYear)],
      ['Coin-days per vote', fmtInt(e.coinDays)],
      ['Reward per epoch', fmt(e.perEpoch) + ' INN'],
      ['Payout quantum', fmtInt(e.quantum) + ' INN']
    ]);

    if (balance <= 0) {
      els.epochNote.textContent = 'Enter an amount to see the per-epoch payout.';
      els.amountHint.textContent = '';
    } else if (e.belowFloor) {
      els.epochNote.innerHTML =
        '<strong class="warn">Below ' + fmtInt(e.quantum) + ' INN this pays nothing.</strong> ' +
        'The reward truncates to zero coin-days per epoch, so the vote is cast and counted ' +
        'for finality but earns no INN. You need ' + gap(e.quantum - balance) +
        ' INN more to earn anything.';
      els.amountHint.textContent = '';
    } else if (e.remainder === 0) {
      els.epochNote.innerHTML =
        'This balance sits exactly on a ' + fmtInt(e.quantum) + ' INN step, so it earns the ' +
        'full ' + pct(CHAIN.coinYearReward) + '. The next step is ' + fmtInt(e.quantum) +
        ' INN away.';
      els.amountHint.textContent =
        'One vote per wallet per epoch — only your single highest-weight key group votes, ' +
        'capped at ' + CHAIN.dag.maxUtxosPerVote + ' UTXOs.';
    } else {
      els.epochNote.innerHTML =
        'The payout steps in ' + fmtInt(e.quantum) + ' INN quanta, so only exact multiples ' +
        'of ' + fmtInt(e.quantum) + ' reach the full ' + pct(CHAIN.coinYearReward) +
        '. Adding ' + gap(e.remainder) + ' INN would reach the next step.';
      els.amountHint.textContent =
        'One vote per wallet per epoch — only your single highest-weight key group votes, ' +
        'capped at ' + CHAIN.dag.maxUtxosPerVote + ' UTXOs.';
    }
  }

  function renderCompare(balance, compound) {
    var a = computePos(balance, compound);
    var b = computeIdag(balance, compound);

    // Each single-mode view writes its own hint; don't inherit the last one.
    els.amountHint.textContent = '';

    var cols = [
      { key: 'pos', tag: 'Today', title: 'Proof of Stake', sub: 'live on mainnet', r: a,
        rows: [
          ['Your rate', pct(a.effectiveRate)],
          ['Yearly', fmt(a.yourYearly, 4) + ' INN'],
          ['Monthly', fmt(a.yourYearly / 12, 4) + ' INN'],
          ['Node cut', pct(CHAIN.nodeShare, 0) + ' · ' + fmt(a.node, 2) + ' INN'],
          ['Paid when', 'you win a PoS block']
        ] },
      { key: 'idag', tag: 'After IDAG', title: 'Finality voting', sub: 'not yet active', r: b,
        rows: [
          ['Your rate', pct(b.effectiveRate)],
          ['Yearly', fmt(b.yourYearly, 4) + ' INN'],
          ['Monthly', fmt(b.yourYearly / 12, 4) + ' INN'],
          ['Node cut', 'none'],
          ['Paid when', 'every ' + CHAIN.dag.epochBlocks + '-block epoch']
        ] }
    ];

    els.compareGrid.innerHTML = '';
    cols.forEach(function (c) {
      var box = document.createElement('div');
      box.className = 'cmp cmp-' + c.key;

      [['cmp-tag', c.tag], ['cmp-title', c.title], ['cmp-sub', c.sub]].forEach(function (p) {
        var el = document.createElement('p');
        el.className = p[0];
        el.textContent = p[1];
        box.appendChild(el);
      });

      var big = document.createElement('p');
      big.className = 'cmp-big';
      big.textContent = balance > 0 ? pct(c.r.effectiveRate) : '—';
      box.appendChild(big);

      var dl = document.createElement('dl');
      dl.className = 'kv cmp-kv';
      box.appendChild(dl);
      kv(dl, c.rows);

      els.compareGrid.appendChild(box);
    });

    if (balance <= 0) {
      els.compareVerdict.textContent = 'Enter an amount to compare.';
    } else if (b.yourYearly <= 0) {
      els.compareVerdict.innerHTML =
        'At this balance IDAG would pay <strong>nothing</strong> — it is below the ' +
        fmtInt(b.epoch.quantum) + ' INN floor, while PoS still pays ' +
        fmt(a.yourYearly, 2) + ' INN a year.';
    } else if (a.yourYearly > 0) {
      var x = b.yourYearly / a.yourYearly;
      els.compareVerdict.innerHTML =
        'IDAG would pay you <strong>' + x.toFixed(2) + '&times; more</strong> — ' +
        fmt(b.yourYearly - a.yourYearly, 2) + ' INN a year extra, on the same stake.';
    } else {
      els.compareVerdict.textContent = '—';
    }

    els.compareNote.innerHTML =
      'Almost all of the difference is the collateral node cut. Both models mint the same ' +
      pct(CHAIN.coinYearReward) + ' a year; today ' + pct(CHAIN.nodeShare, 0) + ' of it leaves ' +
      'to a node operator, and after IDAG none of it does. The IDAG column sits slightly under ' +
      pct(CHAIN.coinYearReward) + ' because its reward truncates to whole coin-days per epoch.';

    els.heroLead.textContent =
      'Innova mints ' + pct(CHAIN.coinYearReward) + ' a year either way. What changes after ' +
      'IDAG is who keeps it: today a collateral node takes ' + pct(CHAIN.nodeShare, 0) +
      ' of every staking reward, and under finality voting it takes none.';
  }

  function renderRules(mode) {
    var common = [
      ['Annual mint rate', pct(CHAIN.coinYearReward) + ' on coin-age'],
      ['Min stake age', CHAIN.stakeMinAgeHours + ' hours'],
      ['Collateral node', fmtInt(CHAIN.nodeCollateral) + ' INN, exact single UTXO'],
      ['Max supply', fmtInt(CHAIN.maxSupply) + ' INN']
    ];

    if (mode === 'idag') {
      kv(els.rulesKv, common.concat([
        ['Staker share', '100% — no node cut on votes'],
        ['Epoch', CHAIN.dag.epochBlocks + ' blocks'],
        ['Block spacing', CHAIN.dag.blockSpacing + 's post-fork'],
        ['Fork height', fmtInt(CHAIN.dag.forkHeight)]
      ]));
      els.rulesNote.innerHTML =
        'Read from the finality-vote code in v5.0.0.0. There is no published IDAG whitepaper — ' +
        'the source is the only spec — and the fork height above is already behind the live ' +
        'chain tip without having activated, so it will likely be re-set before launch.';
    } else {
      kv(els.rulesKv, common.concat([
        ['Staker share', pct(CHAIN.stakerShare, 0)],
        ['Collateral node share', pct(CHAIN.nodeShare, 0)],
        ['Block spacing', '~' + CHAIN.targetSpacing + 's target'],
        ['Coin maturity', CHAIN.maturityBlocks + ' confirmations']
      ]));
      els.rulesNote.innerHTML =
        'Constants read from <code>main.h</code>, <code>main.cpp</code> and <code>wallet.cpp</code> ' +
        'on <a href="https://github.com/innova-foundation/innova" rel="noopener">master</a>. ' +
        'Changing any of them takes a hard fork, so this panel needs no network call.';
    }
  }

  function renderCaveats(mode, compound) {
    var shared = [
      'Your wallet must be online and unlocked for staking. Time spent offline is lost outright.',
      'These are gross rewards before any transaction fees or exchange costs.',
      compound
        ? 'Compounding assumes you restake every reward daily. Real restaking is lumpier, so ' +
          'treat the APY as an upper bound.'
        : null
    ];

    if (mode === 'idag') {
      list(els.caveats, [
        'IDAG is <strong>not running on mainnet</strong>. These figures describe code that ships ' +
        'in v5.0.0.0 but which the live chain is not enforcing.',
        'Rewards truncate to whole coin-days per epoch, so anything under 288 INN earns nothing ' +
        'and larger stakes only hit the full ' + pct(CHAIN.coinYearReward) + ' at exact multiples ' +
        'of 288 INN.',
        'Only <strong>one vote per wallet per epoch</strong> is cast, from your single ' +
        'highest-weight key group and capped at ' + CHAIN.dag.maxUtxosPerVote + ' UTXOs. A ' +
        'balance spread across many addresses will earn less than this page shows.',
        'Your wallet must be online within roughly a 5-block window at each epoch boundary to ' +
        'have its vote counted.'
      ].concat(shared));
    } else if (mode === 'compare') {
      list(els.caveats, [
        'The IDAG column describes rules that are <strong>not active on mainnet</strong>. ' +
        'Only the PoS column reflects what you earn today.',
        'The IDAG figure assumes your whole balance votes as one key group. Spread across many ' +
        'addresses it would earn less, because only the highest-weight group votes each epoch.',
        'Neither column depends on how often you win — coin-age accrues while you wait.'
      ].concat(shared));
    } else {
      list(els.caveats, [
        'The yearly total does <strong>not</strong> depend on how often you win a block. ' +
        'Coin-age accrues while you wait, so winning rarely just means each win pays more. ' +
        'Block frequency drives variance, not the annual figure.',
        'The ' + pct(CHAIN.nodeShare, 0) + ' collateral node cut applies <strong>even when no ' +
        'node is eligible</strong> — in that case it is burned, not paid to you.',
        'After each stake the output needs ' + CHAIN.maturityBlocks + ' confirmations (~19 min) ' +
        'before it can stake again. Coin-age keeps accruing meanwhile, so the loss is negligible.',
        'Innova\'s own docs quote 600 INN a year on a 10,000 INN stake. That is the ' +
        '<strong>gross mint</strong>; after the node cut the staker receives ' +
        fmt(10000 * CHAIN.coinYearReward * CHAIN.stakerShare, 0) + ' INN.'
      ].concat(shared));
    }
  }

  // ---------------------------------------------------------------- live --

  /* One request, not four. chainz rate-limits to about a call every 10s and
   * answers with HTTP 429 for five minutes if pushed, so the whole-explorer
   * summary — which carries height, supply, difficulty and node count in a
   * single 5KB gzipped response — is the only sane shape here. */
  var SUMMARY_URL = 'https://chainz.cryptoid.info/explorer/api.dws?q=summary';
  var PRICE_URL = 'https://api.coingecko.com/api/v3/simple/price' +
                  '?ids=innova&vs_currencies=usd&include_last_updated_at=true';
  var PRICE_MAX_AGE_HOURS = 48;

  /* fetch() has no timeout of its own — a stalled connection would leave the
   * status dot on "loading" indefinitely. Returns undefined where
   * AbortController is missing, which fetch() ignores. */
  function timeout(ms) {
    if (!window.AbortController) return undefined;
    var ac = new AbortController();
    setTimeout(function () { ac.abort(); }, ms);
    return ac.signal;
  }

  function renderNet(data, state, note) {
    net = data;
    els.netDot.dataset.state = state;
    els.netStatus.textContent = note;

    els.hsHeight.textContent = fmtInt(data.height);
    els.hsSupply.textContent = data.supply ? fmtInt(data.supply) + ' INN' : '—';
    els.hsNodes.textContent = fmtInt(data.nodes);
    els.hsRate.textContent = pct(CHAIN.coinYearReward);

    kv(els.netKv, [
      ['Block height', fmtInt(data.height)],
      ['Circulating supply', data.supply ? fmtInt(data.supply) + ' INN' : '—'],
      ['Percent of max', pct(data.supply / CHAIN.maxSupply, 1)],
      ['Collateral nodes', fmtInt(data.nodes)],
      ['Coins in nodes', data.nodes ? fmtInt(data.nodes * CHAIN.nodeCollateral) + ' INN' : '—'],
      ['PoW subsidy now', fmt(powSubsidy(data.height), 4) + ' INN/block'],
      ['Difficulty', data.diff ? Number(data.diff).toFixed(8) : '—'],
      data.price ? ['Price', '$' + data.price.toFixed(8) + ' USD'] : null,
      data.priceNote ? ['Market price', data.priceNote] : null
    ]);

    renderNodePanel(data);
  }

  function renderNodePanel(data) {
    var n = computeNode(data.height, data.nodes);
    if (!n) {
      kv(els.nodeKv, [['Estimate', 'unavailable — no node count']]);
      els.nodeNote.textContent = '';
      return;
    }

    kv(els.nodeKv, [
      ['Collateral', fmtInt(CHAIN.nodeCollateral) + ' INN'],
      ['Nodes running', fmtInt(n.nodes)],
      ['PoW subsidy', fmt(n.subsidy, 4) + ' INN/block'],
      ['Node share of block', pct(CHAIN.nodeShare, 0)],
      ['Est. per node / day', fmt(n.low.perDay, 2) + ' – ' + fmt(n.high.perDay, 2) + ' INN'],
      ['Est. per node / year', fmtInt(n.low.perYear) + ' – ' + fmtInt(n.high.perYear) + ' INN'],
      ['Est. APR on collateral', pct(n.low.apr, 0) + ' – ' + pct(n.high.apr, 0), 'big']
    ]);

    els.nodeNote.innerHTML =
      'The range spans block spacing from the ' + CHAIN.spacingRange[0] + 's protocol target to ' +
      'the ~' + CHAIN.spacingRange[1] + 's actually observed, and assumes ' +
      pct(CHAIN.powBlockShare, 0) + ' of blocks are PoW. It scales with <strong>1 / node ' +
      'count</strong>: at ' + fmtInt(n.nodes * 2) + ' nodes it would roughly halve. Payout order ' +
      'is randomised with a no-repeat-until-cycle rule, so individual timing varies a lot.';
  }

  function loadChain() {
    /* Served from an onion, both fetches would send Origin: http://<addr>.onion.
     * That header is mandatory for CORS and cannot be suppressed, so every
     * visitor would leak the onion address to chainz and CoinGecko via an exit
     * node. Don't make the request at all; the baked-in snapshot covers it. */
    if (/\.onion$/i.test(location.hostname)) {
      renderNet(CHAIN.fallback, 'stale', 'onion build — snapshot, no clearnet calls');
      return;
    }

    if (!window.fetch) {
      renderNet(CHAIN.fallback, 'stale', 'no fetch — 2026-09-05 snapshot');
      return;
    }

    fetch(SUMMARY_URL, { mode: 'cors', signal: timeout(8000) })
      .then(function (res) {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.json();
      })
      .then(function (all) {
        var inn = all && all.inn;
        if (!inn || typeof inn.height !== 'number') throw new Error('no INN entry');
        renderNet({
          height: inn.height,
          supply: inn.supply,
          nodes: inn.masternodes ? inn.masternodes.nodes : null,
          diff: inn.diff
        }, 'live', 'live from chainz');
        loadPrice();
      })
      .catch(function (err) {
        renderNet(CHAIN.fallback, 'stale', 'explorer down (' + err.message + ') — snapshot');
        loadPrice();
      });
  }

  /* INN is effectively delisted: the only CORS-friendly quote left is
   * CoinGecko's, and at the time of writing it had not moved since
   * 2025-11-07. Printing a number that stale next to live chain data would
   * read as a current price, so it is shown only if it is genuinely fresh. */
  function loadPrice() {
    if (!window.fetch || /\.onion$/i.test(location.hostname)) return;

    fetch(PRICE_URL, { mode: 'cors', signal: timeout(8000) })
      .then(function (res) { return res.ok ? res.json() : null; })
      .then(function (d) {
        var p = d && d.innova;
        if (!p || typeof p.usd !== 'number') return;

        var ageHours = p.last_updated_at
          ? (Date.now() / 1000 - p.last_updated_at) / 3600
          : Infinity;

        var merged = {};
        for (var k in net) if (Object.prototype.hasOwnProperty.call(net, k)) merged[k] = net[k];

        if (ageHours <= PRICE_MAX_AGE_HOURS) {
          merged.price = p.usd;
        } else {
          merged.priceNote = 'no current quote — last traded ' +
                             Math.round(ageHours / 24) + ' days ago';
        }
        renderNet(merged, els.netDot.dataset.state, els.netStatus.textContent);
      })
      .catch(function () { /* price is optional; the calculator does not need it */ });
  }

  // ------------------------------------------------------------- url state --

  /* Shareable links. replaceState rather than pushState so typing in the
   * amount field does not stack up dozens of history entries. */
  function syncUrl(balance, mode, compound) {
    if (!window.history || !history.replaceState || !window.URLSearchParams) return;
    var q = new URLSearchParams();
    // The default needs no param — a plain visit keeps a clean URL.
    if (balance > 0 && balance !== parseAmount(els.amount.defaultValue)) {
      q.set('amount', String(balance));
    }
    if (mode !== 'pos') q.set('mode', mode);
    if (root.dataset.skin !== 'retro') q.set('skin', root.dataset.skin);
    if (compound) q.set('compound', '1');
    var s = q.toString();
    history.replaceState(null, '', s ? '?' + s : location.pathname);
  }

  function readUrl() {
    if (!window.URLSearchParams) return;
    var q = new URLSearchParams(location.search);
    // Clean it the same way typing is cleaned, so ?amount=5abc lands as 5.
    var amt = cleanAmount(q.get('amount') || '');
    if (parseAmount(amt) > 0) els.amount.value = amt;
    if (q.get('compound') === '1') els.compound.checked = true;
    // skin and mode were already applied by the inline head script.
  }

  function toast(msg) {
    els.toast.textContent = msg;
    els.toast.hidden = false;
    clearTimeout(toast._t);
    toast._t = setTimeout(function () { els.toast.hidden = true; }, 2200);
  }

  // -------------------------------------------------------------- controls --

  function setSkin(skin) {
    root.dataset.skin = skin;
    var link = $('nes-css');
    if (link) link.disabled = (skin !== 'retro');
    els.skinLabel.textContent = skin === 'retro' ? 'Modern' : 'Retro';
    els.skinBtn.title = skin === 'retro' ? 'Switch to the modern skin' : 'Switch to the retro skin';
    try { localStorage.setItem('poswatch.skin', skin); } catch (e) {}
  }

  function setMode(mode) {
    root.dataset.mode = mode;
    document.querySelectorAll('[data-set-mode]').forEach(function (b) {
      b.setAttribute('aria-pressed', String(b.dataset.setMode === mode));
    });
    try { localStorage.setItem('poswatch.mode', mode); } catch (e) {}
    render();
  }

  els.skinBtn.addEventListener('click', function () {
    setSkin(root.dataset.skin === 'retro' ? 'modern' : 'retro');
    render();
  });

  document.querySelectorAll('[data-set-mode]').forEach(function (b) {
    b.addEventListener('click', function () { setMode(b.dataset.setMode); });
  });

  document.querySelectorAll('[data-preset]').forEach(function (b) {
    b.addEventListener('click', function () {
      els.amount.value = b.dataset.preset;
      render();
    });
  });

  els.amount.addEventListener('input', function () {
    this.value = cleanAmount(this.value);
    render();
  });

  els.compound.addEventListener('change', render);

  els.copyLink.addEventListener('click', function () {
    var url = location.href;
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(url)
        .then(function () { toast('Link copied'); })
        .catch(function () { toast(url); });
    } else {
      toast(url);
    }
  });

  // ----------------------------------------------------------- boot screen --

  /* Two sequences off one DOM, same as the skins. Modern counts smoothly to
   * 100; retro advances in 12 visible chunks so the segmented bar reads as
   * discrete blocks filling, the way an 8-bit loader does.
   *
   * Deliberately NOT tied to the explorer fetch: chainz can take seconds or
   * time out entirely, and a loading screen that waits on it would hold the
   * page hostage to a third party. The data lands in its own panel whenever
   * it arrives. A <noscript> rule in the head hides the overlay outright if
   * this never runs, so it can't trap the page.
   */
  function runBoot() {
    var el = $('boot');
    if (!el || root.classList.contains('booted')) return;
    try { sessionStorage.setItem('poswatch.booted', '1'); } catch (e) {}

    var fill = $('boot-fill'), pctEl = $('boot-pct'), subEl = $('boot-sub');
    var retro = root.dataset.skin === 'retro';
    var reduce = window.matchMedia &&
                 window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    var stages = retro
      ? ['BOOTING NODE', 'SYNCING BLOCKS', 'READY']
      : ['booting node', 'syncing chain data', 'ready'];

    function paint(p) {
      if (fill) fill.style.width = p + '%';
      if (pctEl) pctEl.textContent = p + '%';
      if (subEl) subEl.textContent = stages[p < 45 ? 0 : (p < 100 ? 1 : 2)];
    }

    if (reduce) { paint(100); el.classList.add('is-done'); return; }

    var steps = retro ? 12 : 50;
    var total = retro ? 1500 : 1150;
    var i = 0;

    var timer = setInterval(function () {
      i++;
      paint(Math.min(100, Math.round((i / steps) * 100)));
      if (i >= steps) {
        clearInterval(timer);
        setTimeout(function () { el.classList.add('is-done'); }, retro ? 320 : 180);
      }
    }, total / steps);
  }

  // ---------------------------------------------------------------- boot --

  readUrl();
  setSkin(root.dataset.skin || 'retro');
  setMode(root.dataset.mode || 'pos');
  renderNet(CHAIN.fallback, 'loading', 'loading…');
  loadChain();
  runBoot();
})();
