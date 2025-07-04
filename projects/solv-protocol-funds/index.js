const abi = require("./abi.json");
const { default: BigNumber } = require("bignumber.js");
const { getConfig } = require("../helper/cache");
const { cachedGraphQuery } = require("../helper/cache");
const { sumTokens2, } = require("../helper/unwrapLPs");
const { getAmounts } = require("./iziswap");
const { sumTokens2: sumTokens2Solana, getTokenSupplies } = require('../helper/solana')

// The Graph
const graphUrlList = {
  ethereum: 'https://api.studio.thegraph.com/query/40045/solv-payable-factory-prod/version/latest',
  bsc: 'https://api.studio.thegraph.com/query/40045/solv-payable-factory-bsc/version/latest',
  arbitrum: 'https://api.studio.thegraph.com/query/40045/solv-payable-factory-arbitrum/version/latest',
  mantle: 'https://api.0xgraph.xyz/api/public/65c5cf65-bd77-4da0-b41c-cb6d237e7e2f/subgraphs/solv-payable-factory-mentle-0xgraph/-/gn',
  merlin: 'http://solv-subgraph-server-alb-694489734.us-west-1.elb.amazonaws.com:8000/subgraphs/name/solv-payable-factory-merlin',
}

const slotListUrl = 'https://raw.githubusercontent.com/solv-finance/solv-protocol-defillama/refs/heads/main/solv-rwa-slot.json';

const addressUrl = 'https://raw.githubusercontent.com/solv-finance/solv-protocol-defillama/refs/heads/main/solv-funds.json';

const solvTokens = {
  ethereum: [
    '0x7A56E1C57C7475CCf742a1832B028F0456652F97',
  ],
  bsc: [
    '0x4aae823a6a0b376De6A78e74eCC5b079d38cBCf7',
  ],
  arbitrum: [
    '0x3647c54c4c2C65bC7a2D63c0Da2809B399DBBDC0',
  ]
}

async function tvl(api) {
  const address = (await getConfig('solv-protocol/funds', addressUrl));
  const graphData = await getGraphData(api.timestamp, api.chain, api);

  await gm(api, address);
  await mux(api, address);
  await klp(api, address);
  await iziswap(api, address);
  await derivativeToken(api, address);
  await vaultBalance(api, address, graphData);
  await otherDeposit(api, address);
  await ceffuBalance(api, address, graphData);
  await lpV3PositionsBalance(api, address);
  await aaveSupplyBalance(api, address);
  await solanaTvl(api, address);
  await tokenSupply(api, address);
  await solanaTokenSupply(api, address);

  (solvTokens[api.chain] ?? []).forEach(token => {
    api.removeTokenBalance(token)
  })
}

const solvbtcListUrl = 'https://raw.githubusercontent.com/solv-finance/solv-protocol-defillama/refs/heads/main/solvbtc.json';
async function getSolvBTCVAddresses(api) {
  let solvbtc = (await getConfig('solv-protocol/solvbtc', solvbtcListUrl));

  const blacklisted = {}
  if (!solvbtc[api.chain] || !solvbtc[api.chain]["otherDeposit"]) {
    return blacklisted
  }
  let otherDeposit = solvbtc[api.chain]["otherDeposit"];
  for (const deposit of otherDeposit["depositAddress"]) {
    for (const tokenAddress of otherDeposit["tokens"]) {
      const key = `${tokenAddress}-${deposit}`.toLowerCase()
      blacklisted[key] = true
    }
  }
  return blacklisted
}

async function otherDeposit(api, address) {
  if (!address[api.chain] || !address[api.chain]["otherDeposit"]) {
    return;
  }
  let otherDeposit = address[api.chain]["otherDeposit"];

  let tokens = []
  for (const deposit of otherDeposit["depositAddress"]) {
    for (const tokenAddress of otherDeposit["tokens"]) {
      tokens.push({ tokenAddress, deposit })
    }
  }

  await sumTokens2({ api, tokensAndOwners: tokens.map(i => [i.tokenAddress, i.deposit]), permitFailure: true });
}

async function gm(api, address) {
  if (!address[api.chain] || !address[api.chain]["gm"]) {
    return;
  }
  let gm = address[api.chain]["gm"];

  let tokens = []
  for (const pool of gm["depositAddress"]) {
    for (const address of gm["gmTokens"]) {
      tokens.push({ address, pool })
    }
  }

  await sumTokens2({ api, tokensAndOwners: tokens.map(i => [i.address, i.pool]), permitFailure: true });
}

async function mux(api, address) {
  if (!address[api.chain] || !address[api.chain]["mux"]) {
    return;
  }
  let mux = address[api.chain]["mux"];

  const amount = await api.call({ abi: abi.stakedMlpAmount, target: mux.pool, params: mux.account });

  api.add(mux.lp, amount)
}

async function klp(api, address) {
  if (!address[api.chain] || !address[api.chain]["klp"]) {
    return;
  }
  let klp = address[api.chain]["klp"];

  const stakedAmounts = await api.multiCall({
    abi: abi.stakedAmountsAbi,
    calls: klp["klpPool"].map((pool) => ({
      target: klp["address"],
      params: [pool]
    })),
  })

  stakedAmounts.forEach(amount => {
    api.add(klp["address"], amount)
  })
}

async function iziswap(api, address) {
  if (!address[api.chain] || !address[api.chain]["iziswap"]) {
    return;
  }
  let iziswapData = address[api.chain]["iziswap"];

  const iziswap = iziswapData.liquidityManager;
  const owner = iziswapData.owner;

  let liquidities = [];
  for (let i = 0; i < owner.length; i++) {
    liquidities.push(liquidity(api, iziswap, owner[i]))
  }

  await Promise.all(liquidities);
}

async function liquidity(api, iziswap, owner) {
  const balanceOf = await api.call({ abi: abi.balanceOf, target: iziswap, params: [owner] })

  let indexs = [];
  for (let i = 0; i < balanceOf; i++) {
    indexs.push(i);
  }

  const tokenIds = await api.multiCall({
    abi: abi.tokenOfOwnerByIndex,
    calls: indexs.map((index) => ({
      target: iziswap,
      params: [owner, index]
    })),
  })

  const liquidities = await api.multiCall({
    abi: abi.liquidities,
    calls: tokenIds.map((tokenId) => ({
      target: iziswap,
      params: [tokenId]
    }))
  })

  const poolMetas = await api.multiCall({
    abi: abi.poolMetas,
    calls: liquidities.map((liquidity) => ({
      target: iziswap,
      params: [liquidity[7]]
    }))
  })

  let tokenList = [...poolMetas]

  let poolList = await api.multiCall({
    abi: abi.pool,
    target: iziswap,
    calls: poolMetas.map((pool) => ({
      params: [pool[0], pool[1], pool[2]]
    }))
  })
  let state = await api.multiCall({
    abi: abi.state,
    calls: poolList.map((pool) => ({
      target: pool
    }))
  })

  tokenList.forEach((token, index) => {
    const amounts = getAmounts(state[index], liquidities[index])
    api.add(token[0], amounts.amountX);
    api.add(token[1], amounts.amountY);
  })
}

async function concrete(slots, api) {
  var slotsList = [];
  var only = {};
  for (var i = 0; i < slots.length; i++) {
    if (!only[slots[i].contractAddress]) {
      slotsList.push(slots[i]);
      only[slots[i].contractAddress] = true;
    }
  }

  const concreteLists = await api.multiCall({
    calls: slotsList.map((index) => index.contractAddress),
    abi: abi.concrete,
  })

  let concretes = {};
  for (var k = 0; k < concreteLists.length; k++) {
    concretes[slotsList[k].contractAddress] = concreteLists[k];
  }

  return concretes;
}

async function derivativeToken(api, address) {
  if (!address[api.chain] || !address[api.chain]["derivativeData"]) {
    return;
  }
  let derivativeTokenData = address[api.chain]["derivativeData"];

  const balance = await api.call({ abi: abi.balanceOf, target: derivativeTokenData.derivativeToken, params: derivativeTokenData.account.userAddress });

  api.add(derivativeTokenData.account.underlyingToken, balance)
}

async function vaultBalance(api, address, graphData) {
  const network = api.chain;

  let solvbtc = (await getConfig('solv-protocol/solvbtc', solvbtcListUrl));
  if (graphData.pools.length > 0) {
    const poolLists = graphData.pools;

    const poolConcretes = await concrete(poolLists, api);

    const poolBaseInfos = await api.multiCall({
      permitFailure: true,
      abi: abi.slotBaseInfo,
      calls: poolLists.map((index) => ({
        target: poolConcretes[index.contractAddress],
        params: [index.openFundShareSlot],
      })),
    })

    let vaultAddress = [];
    for (const key in poolLists) {
      if (poolBaseInfos[key] && solvbtc[network] != undefined && solvbtc[network]['slot'] != undefined && solvbtc[network]['slot'].indexOf(poolLists[key]["openFundShareSlot"]) != -1) {
        vaultAddress.push(`${poolBaseInfos[key][1].toLowerCase()}-${poolLists[key]["vault"].toLowerCase()}`);
      }
    }

    let vaults = {};
    const blacklistedOwners = address[network].blacklistedOwners || [];
    for (const key in poolLists) {
      if (poolBaseInfos[key] && poolBaseInfos[key][1] && poolLists[key]["vault"] && blacklistedOwners.indexOf(poolLists[key]["vault"].toLowerCase()) == -1 && vaultAddress.indexOf(`${poolBaseInfos[key][1].toLowerCase()}-${poolLists[key]["vault"].toLowerCase()}`) == -1) {
        vaults[`${poolBaseInfos[key][1].toLowerCase()}-${poolLists[key]["vault"].toLowerCase()}`] = [poolBaseInfos[key][1], poolLists[key]["vault"]]
      }
    }
    const tokens = Object.values(vaults).map(([token]) => token)

    const symbols = await api.multiCall({ abi: abi.symbol, calls: tokens, })
    const blacklisted = await getSolvBTCVAddresses(api)
    const blacklistedTokens = tokens.filter((token, i) => symbols[i].toLowerCase().includes('solvbtc'))
    const tokensAndOwners = Object.values(vaults).filter(([token, owner]) => {
      const key = `${token}-${owner}`.toLowerCase()
      return !blacklisted[key] && !blacklistedTokens.includes(token)
    })
    return api.sumTokens({ tokensAndOwners, blacklistedTokens, })
  }
}

async function ceffuBalance(api, address, graphData) {
  if (!address[api.chain] || !address[api.chain]["ceffu"]) {
    return;
  }
  let ceffuData = address[api.chain]["ceffu"];

  let pools = [];
  for (const graph of graphData.pools) {
    if (graph['openFundShareSlot'] == ceffuData['slot']) {
      pools.push(graph)
    }
  }
  if (pools.length > 0) {
    const poolConcretes = await concrete(pools, api);
    const nav = await api.multiCall({
      abi: abi.getSubscribeNav,
      calls: pools.map((index) => ({
        target: index.navOracle,
        params: [index.poolId, api.timestamp * 1000]
      })),
    })

    const poolTotalValues = await api.multiCall({
      abi: abi.slotTotalValue,
      calls: pools.map((index) => ({
        target: poolConcretes[index.contractAddress],
        params: [index.openFundShareSlot]
      })),
    })

    const poolBaseInfos = await api.multiCall({
      abi: abi.slotBaseInfo,
      calls: pools.map((index) => ({
        target: poolConcretes[index.contractAddress],
        params: [index.openFundShareSlot]
      })),
    })

    const poolDecimalList = await api.multiCall({
      abi: abi.decimals,
      calls: poolBaseInfos.map(i => i[1]),
    })

    let vaults = {};
    for (const key in pools) {
      if (poolBaseInfos[key] && poolBaseInfos[key][1] && pools[key]["vault"]) {
        vaults[`${pools[key]["vault"].toLowerCase()}-${poolBaseInfos[key][1].toLowerCase()}`] = [poolBaseInfos[key][1], pools[key]["vault"]]
      }
    }

    const balances = await api.multiCall({
      abi: abi.balanceOf,
      calls: Object.values(vaults).map((index) => ({
        target: index[0],
        params: [index[1]]
      })),
    })

    let vaultbalances = {};
    for (let i = 0; i < Object.keys(vaults).length; i++) {
      vaultbalances[Object.keys(vaults)[i]] = balances[i];
    }

    for (let i = 0; i < poolTotalValues.length; i++) {
      const decimals = poolDecimalList[i];
      let balance = BigNumber(poolTotalValues[i]).div(BigNumber(10).pow(18 - decimals)).times(BigNumber(nav[i].nav_).div(BigNumber(10).pow(decimals))).toNumber();
      if (pools[i]['vault'] && poolBaseInfos[i][1] && vaultbalances[`${pools[i]['vault'].toLowerCase()}-${poolBaseInfos[i][1].toLowerCase()}`]) {
        balance = BigNumber(balance).minus(vaultbalances[`${pools[i]['vault'].toLowerCase()}-${poolBaseInfos[i][1].toLowerCase()}`]).toNumber();
        vaultbalances[`${pools[i]['vault'].toLowerCase()}-${poolBaseInfos[i][1].toLowerCase()}`] = undefined
      }

      if (ceffuData["ceffus"]) {
        let ceffus = [];
        for (const deposit of ceffuData["ceffus"]["depositAddress"]) {
          for (const tokenAddress of ceffuData["ceffus"]["tokens"]) {
            ceffus.push({ tokenAddress, deposit })
          }
        }

        const balances = await api.multiCall({
          abi: abi.balanceOf,
          calls: Object.values(ceffus).map((index) => ({
            target: index["tokenAddress"],
            params: [index["deposit"]]
          })),
        })
        for (const balanceOf of balances) {
          balance = BigNumber(balance).minus(balanceOf).toNumber();
        }
      }

      if (balance > 0) {
        api.add(poolBaseInfos[i][1], balance)
      }
    }
  }
}

async function lpV3PositionsBalance(api, address) {
  if (!address[api.chain] || !address[api.chain]["lpV3Positions"]) {
    return;
  }
  let lpV3PositionsData = address[api.chain]["lpV3Positions"];
  await sumTokens2({ api, uniV3nftsAndOwners: lpV3PositionsData["lpV3nftsAndOwners"], blacklistedTokens: lpV3PositionsData["blacklistedTokens"] ?? [], resolveLP: true, })
}

async function aaveSupplyBalance(api, address) {
  if (!address[api.chain] || !address[api.chain]["aaves"]) {
    return;
  }
  let aavesData = address[api.chain]["aaves"];

  const allCalls = [];
  for (let i = 0; i < aavesData.length; i++) {
    const aaveAddress = aavesData[i];
    allCalls.push(...Object.values(aaveAddress["aaveAddress"]).map((index) => ({
      target: index[0],
      params: [index[1]]
    })));
  }
  const balances = await api.multiCall({
    abi: abi.balanceOf,
    calls: allCalls,
  });

  for (let i = 0; i < balances.length; i++) {
    const balance = balances[i];
    const aaveAddress = aavesData[Math.floor(i / Object.values(aavesData[i % aavesData.length]["aaveAddress"]).length)];
    api.add(aaveAddress["assetAddress"], balance);
  }
}

async function solanaTvl(api, address) {
  if (api.chain !== 'solana' || !address[api.chain] || !address[api.chain]["solanaOwners"]) return;
  const owners = address[api.chain]["solanaOwners"];
  return sumTokens2Solana({ api, owners });
}

async function tokenSupply(api, address) {
  if (!address[api.chain] || !address[api.chain]["tokenSupply"]) {
    return;
  }
  let tokenSupplyData = address[api.chain]["tokenSupply"];

  const totalSupplys = await api.multiCall({
    abi: abi.totalSupply,
    calls: tokenSupplyData.map((address) => ({
      target: address,
    })),
  });


  for (let i = 0; i < tokenSupplyData.length; i++) {
    api.add(tokenSupplyData[i], totalSupplys[i]);
  }
}

async function solanaTokenSupply(api, address) {
  if (api.chain !== 'solana' || !address[api.chain] || !address[api.chain]["solanaTokens"]) return;
  const tokens = address[api.chain]["solanaTokens"];
  return getTokenSupplies(tokens, { api });
}

async function getGraphData(timestamp, chain, api) {
  let rwaSlot = (await getConfig('solv-protocol/slots', slotListUrl));

  const slotDataQuery = `query PoolOrderInfos {
            poolOrderInfos(first: 1000  where:{fundraisingEndTime_gt:${timestamp}, openFundShareSlot_not_in: ${JSON.stringify(rwaSlot)}}) {
              marketContractAddress
              contractAddress
              navOracle
              poolId
              vault
              openFundShareSlot
          }
        }`;

  let data;
  if (graphUrlList[chain]) {
    data = (await cachedGraphQuery(`solv-protocol/funds-graph-data/${chain}`, graphUrlList[chain], slotDataQuery, { api, }));
  }

  let poolList = [];
  if (data != undefined && data.poolOrderInfos != undefined) {
    poolList = data.poolOrderInfos;
  }

  return {
    pools: poolList
  };
}


// node test.js projects/solv-protocol-funds
['ethereum', 'bsc', 'polygon', 'arbitrum', 'mantle', 'merlin', 'solana', 'soneium'].forEach(chain => {
  module.exports[chain] = {
    tvl
  }
})
