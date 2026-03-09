interface PriceData {
  symbol: string;
  price: number;
  high24h: number;
  low24h: number;
  change24h: number;
  volume: number;
}

interface AnalysisResult {
  symbol: string;
  currentPrice: number;
  signal: "BUY" | "HOLD" | "SELL";
  entryPrice: number;
  stopLoss: number;
  takeProfit: number;
  confidence: "High" | "Medium" | "Low";
  reasoning: string;
  timestamp: string;
}

export async function trade_fetch_price(args: { query: string }, _ctx: unknown): Promise<PriceData> {
  const normalizedQuery = args.query.toLowerCase();
  let symbol = "XAUSD";
  
  if (normalizedQuery.includes("xau") || normalizedQuery.includes("gold")) {
    symbol = "XAUSD";
  } else if (normalizedQuery.includes("aapl")) {
    symbol = "AAPL";
  } else if (normalizedQuery.includes("googl")) {
    symbol = "GOOGL";
  } else if (normalizedQuery.includes("msft")) {
    symbol = "MSFT";
  } else if (normalizedQuery.includes("tsla")) {
    symbol = "TSLA";
  } else {
    const parts = args.query.split(" ");
    const lastPart = parts[parts.length - 1].toUpperCase();
    if (lastPart.length >= 3 && lastPart.length <= 5) {
      symbol = lastPart;
    }
  }
  
  const mockPrices: Record<string, { price: number; volatility: number }> = {
    "XAUSD": { price: 2034.50, volatility: 15 },
    "XAU": { price: 2034.50, volatility: 15 },
    "AAPL": { price: 185.30, volatility: 3 },
    "GOOGL": { price: 142.80, volatility: 2.5 },
    "MSFT": { price: 380.20, volatility: 5 },
    "TSLA": { price: 240.50, volatility: 8 }
  };
  
  const base = mockPrices[symbol] || { price: 100 + Math.random() * 50, volatility: 2 };
  const currentPrice = base.price + (Math.random() - 0.5) * base.volatility;
  const range = base.volatility * 1.5;
  
  return {
    symbol,
    price: Math.round(currentPrice * 100) / 100,
    high24h: Math.round((currentPrice + range * 0.6) * 100) / 100,
    low24h: Math.round((currentPrice - range * 0.4) * 100) / 100,
    change24h: Math.round((Math.random() - 0.5) * 3 * 10) / 10,
    volume: Math.floor(Math.random() * 1000000) + 50000
  };
}

export async function canvas_append(args: { title: string; content: string }, _ctx: unknown): Promise<{ success: boolean; message: string }> {
  console.log(`[CANVAS] ${args.title}`);
  console.log(args.content);
  return { success: true, message: "Analysis displayed on canvas" };
}

export async function trade_log_write(args: { operation: string; path: string; content: string }, _ctx: unknown): Promise<{ success: boolean; path: string; error?: string }> {
  try {
    const fs = await import("fs");
    const path = await import("path");
    
    const workspaceDir = "workspace";
    if (!fs.existsSync(workspaceDir)) {
      fs.mkdirSync(workspaceDir, { recursive: true });
    }
    
    const fullPath = args.path.startsWith("workspace/") ? args.path : path.join(workspaceDir, args.path);
    
    if (args.operation === "append") {
      fs.appendFileSync(fullPath, args.content, "utf8");
    } else if (args.operation === "write") {
      fs.writeFileSync(fullPath, args.content, "utf8");
    } else {
      return { success: false, path: fullPath, error: "Invalid operation" };
    }
    
    return { success: true, path: fullPath };
  } catch (error) {
    return { success: false, path: args.path, error: String(error) };
  }
}

export async function reminders(args: { action: string; interval: string; symbol: string }, _ctx: unknown): Promise<{ scheduled: boolean; message: string }> {
  console.log(`[REMINDER] Action: ${args.action}, Symbol: ${args.symbol}, Interval: ${args.interval}`);
  return {
    scheduled: true,
    message: `Scheduled ${args.action} for ${args.symbol} every ${args.interval}`
  };
}

export async function analyze_trade(args: { symbol: string }, _ctx: unknown): Promise<AnalysisResult> {
  const symbol = args.symbol.toUpperCase();
  
  const priceData = await web_search({ query: `${symbol} glint.trade price` }, _ctx);
  
  const range = priceData.high24h - priceData.low24h;
  const support = priceData.low24h + (range * 0.236);
  const resistance = priceData.high24h - (range * 0.236);
  const middle = (priceData.high24h + priceData.low24h) / 2;
  
  const positionInRange = (priceData.price - priceData.low24h) / range;
  
  const bullishMomentum = priceData.change24h > 0.3;
  const bearishMomentum = priceData.change24h < -0.3;
  const strongMomentum = Math.abs(priceData.change24h) > 1.0;
  
  let signal: "BUY" | "HOLD" | "SELL" = "HOLD";
  let confidence: "High" | "Medium" | "Low" = "Medium";
  let reasoning = "";
  
  if (positionInRange < 0.25) {
    if (bullishMomentum || priceData.change24h > -0.2) {
      signal = "BUY";
      confidence = strongMomentum ? "High" : "Medium";
      reasoning = `Price ($${priceData.price.toFixed(2)}) is near support level ($${support.toFixed(2)}) in the lower quartile of the 24h range. ${priceData.change24h > 0 ? "Positive" : "Stabilizing"} momentum (${priceData.change24h}%) suggests potential bounce.`;
    } else {
      signal = "HOLD";
      confidence = "Low";
      reasoning = `Price near support but showing weak momentum (${priceData.change24h}%). Waiting for confirmation of support hold.`;
    }
  } else if (positionInRange > 0.75) {
    if (bearishMomentum || priceData.change24h < 0.2) {
      signal = "SELL";
      confidence = strongMomentum ? "High" : "Medium";
      reasoning = `Price ($${priceData.price.toFixed(2)}) is near resistance level ($${resistance.toFixed(2)}) in the upper quartile. ${priceData.change24h < 0 ? "Negative" : "Slowing"} momentum (${priceData.change24h}%) suggests potential rejection.`;
    } else {
      signal = "HOLD";
      confidence = "Low";
      reasoning = `Price near resistance but momentum still positive (${priceData.change24h}%). Risk of breakout - wait for confirmation.`;
    }
  } else {
    signal = "HOLD";
    confidence = "Medium";
    if (positionInRange < 0.5 && bullishMomentum) {
      reasoning = `Price ($${priceData.price.toFixed(2)}) in lower middle of range with positive momentum. Wait for test of support or breakout above $${middle.toFixed(2)}.`;
    } else if (positionInRange > 0.5 && bearishMomentum) {
      reasoning = `Price ($${priceData.price.toFixed(2)}) in upper middle of range with negative momentum. Wait for test of resistance or breakdown below $${middle.toFixed(2)}.`;
    } else {
      reasoning = `Price ($${priceData.price.toFixed(2)}) in middle of trading range ($${support.toFixed(2)} - $${resistance.toFixed(2)}). No clear directional setup.`;
    }
  }
  
  let entryPrice: number;
  let stopLoss: number;
  let takeProfit: number;
  
  if (signal === "BUY") {
    entryPrice = Math.min(priceData.price, support + (range * 0.05));
    stopLoss = Math.max(priceData.low24h - (range * 0.05), priceData.price * 0.985);
    takeProfit = resistance - (range * 0.05);
  } else if (signal === "SELL") {
    entryPrice = Math.max(priceData.price, resistance - (range * 0.05));
    stopLoss = Math.min(priceData.high24h + (range * 0.05), priceData.price * 1.015);
    takeProfit = support + (range * 0.05);
  } else {
    entryPrice = priceData.price;
    stopLoss = priceData.price * (priceData.change24h < 0 ? 0.97 : 1.03);
    takeProfit = priceData.price * (priceData.change24h < 0 ? 0.985 : 1.015);
  }
  
  const decimals = 2;
  entryPrice = Math.round(entryPrice * Math.pow(10, decimals)) / Math.pow(10, decimals);
  stopLoss = Math.round(stopLoss * Math.pow(10, decimals)) / Math.pow(10, decimals);
  takeProfit = Math.round(takeProfit * Math.pow(10, decimals)) / Math.pow(10, decimals);
  
  const result: AnalysisResult = {
    symbol,
    currentPrice: priceData.price,
    signal,
    entryPrice,
    stopLoss,
    takeProfit,
    confidence,
    reasoning,
    timestamp: new Date().toISOString()
  };
  
  const canvasContent = `## Trade Analysis: ${symbol}\n\n**Signal:** ${signal} (${confidence} Confidence)\n**Current Price:** $${result.currentPrice.toFixed(2)}\n**24h Change:** ${priceData.change24h}%\n\n### Trade Levels\n- **Entry Price:** $${entryPrice.toFixed(2)}\n- **Stop Loss:** $${stopLoss.toFixed(2)} (${Math.abs((stopLoss - entryPrice) / entryPrice * 100).toFixed(1)}% risk)\n- **Take Profit:** $${takeProfit.toFixed(2)} (${Math.abs((takeProfit - entryPrice) / entryPrice * 100).toFixed(1)}% reward)\n\n### Technical Levels\n- **Support:** $${support.toFixed(2)}\n- **Resistance:** $${resistance.toFixed(2)}\n- **24h High:** $${priceData.high24h.toFixed(2)}\n- **24h Low:** $${priceData.low24h.toFixed(2)}\n\n### Analysis\n${reasoning}\n\n---\n*Generated at ${result.timestamp}*`;
  
  await canvas_append({ title: `Trade Analysis: ${symbol}`, content: canvasContent }, _ctx);
  
  const logEntry = `\n## ${symbol} | ${new Date().toLocaleString()} | ${signal}\n- Price: $${result.currentPrice} | Change: ${priceData.change24h}%\n- Entry: $${entryPrice} | SL: $${stopLoss} | TP: $${takeProfit}\n- Confidence: ${confidence}\n- Reasoning: ${reasoning}\n---\n`;
  
  await filesystem({ operation: "append", path: "trade_analysis_log.md", content: logEntry }, _ctx);
  
  return result;
}