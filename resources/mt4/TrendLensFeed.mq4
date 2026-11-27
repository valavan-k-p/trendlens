//+------------------------------------------------------------------+
//| TrendLensFeed.mq4                                                |
//| Read-only live data feed for the TrendLens desktop app.          |
//|                                                                  |
//| SAFETY                                                           |
//|  * Contains NO order functions (no OrderSend / OrderModify /     |
//|    OrderClose / OrderDelete). TrendLens's tests check this.      |
//|  * Writes only to Terminal\Common\Files\TrendLens\ (FILE_COMMON).|
//|  * Changes nothing in the terminal: no Market Watch edits, no    |
//|    chart objects, no indicators.                                 |
//|                                                                  |
//| OUTPUT                                                           |
//|  candles_<SYMBOL>_<TF>.csv  closed bars (rewritten with a        |
//|                             backfill at start, then appended)    |
//|  heartbeat.json             every HeartbeatMs: bid/ask and the   |
//|                             bar currently forming on every TF    |
//|  options.json               every OptionsMs: quotes of the option|
//|                             symbols in Market Watch (description |
//|                             contains " CE " or " PE ") and of    |
//|                             UnderlyingSymbols                    |
//+------------------------------------------------------------------+
#property copyright "TrendLens"
#property version   "1.11"
#property strict

input string Symbols      = "";                       // comma-separated; empty = this chart + Market Watch instruments
input string Timeframes   = "1,5,15,30,60,240,1440";  // minutes
input int    BackfillBars = 2000;                     // closed bars written at start-up per symbol/TF
input int    MaxSymbols   = 40;                       // cap when Symbols is empty
input int    HeartbeatMs  = 1000;                     // live price / forming-bar refresh
input bool   ExportOptions     = true;                // write option quotes to options.json
input int    OptionsMs         = 500;                 // option quote refresh (written only when a price changed)
input string UnderlyingSymbols = "NIFTY#,BANKNIFTY#,FINNIFTY#,SENSEX,MCRO,NIFTY,BANKNIFTY,FINNIFTY"; // spot / futures prices sent with the options

#define OUT_DIR       "TrendLens\\"
#define FEED_VERSION  "1.11"
#define CANDLE_HEADER "bar_time,symbol,tf,open,high,low,close,tick_volume,observed_server_time,source,session"
#define OWNER_GV      "TRENDLENS_FEED_OWNER"
#define OWNER_TS_GV   "TRENDLENS_FEED_OWNER_TS"

string   g_symbols[];
int      g_tfs[];
datetime g_lastBar[];     // [symbol * ntf + tf]
bool     g_filled[];      // backfill done for [symbol * ntf + tf]
string   g_session;
double   g_token   = 0;
bool     g_started = false;
datetime g_lastRetry = 0;
uint     g_lastOptions = 0;
uint     g_lastHeartbeat = 0;
uint     g_lastOptWrite = 0;
string   g_lastOptBody = "";

//+------------------------------------------------------------------+
int OnInit()
  {
   MathSrand((int)(GetTickCount() ^ (uint)(ChartID() % 2147483647)));
   g_session = IntegerToString((long)TimeLocal()) + "_" + IntegerToString(MathRand());
   g_token   = (double)(GetTickCount() % 1000000) * 32768.0 + (double)MathRand() + 1.0;
   BuildSymbols();
   BuildTimeframes();
   int n = ArraySize(g_symbols) * ArraySize(g_tfs);
   ArrayResize(g_lastBar, n);
   ArrayResize(g_filled, n);
   ArrayInitialize(g_lastBar, 0);
   ArrayInitialize(g_filled, false);
   // The timer runs at the faster of the heartbeat and option intervals; each output keeps its own pace.
   EventSetMillisecondTimer((int)MathMax(100, ExportOptions ? MathMin(HeartbeatMs, OptionsMs) : HeartbeatMs));
   Print("TrendLensFeed ", FEED_VERSION, ": ", ArraySize(g_symbols), " symbols, timeframes ", Timeframes);
   return(INIT_SUCCEEDED);
  }

void OnDeinit(const int reason)
  {
   EventKillTimer();
   if(GlobalVariableCheck(OWNER_GV) && GlobalVariableGet(OWNER_GV) == g_token) GlobalVariableDel(OWNER_GV);
  }

void OnTick()  { if(g_started) Poll(); }

void OnTimer()
  {
   if(!IsWriter()) { g_started = false; return; }
   if(!g_started) { g_started = true; BackfillPending(); }
   else if(TimeLocal() - g_lastRetry >= 10) BackfillPending();
   Poll();
   if(GetTickCount() - g_lastHeartbeat >= (uint)MathMax(250, HeartbeatMs))
     {
      g_lastHeartbeat = GetTickCount();
      WriteHeartbeat();
     }
   if(ExportOptions && GetTickCount() - g_lastOptions >= (uint)MathMax(100, OptionsMs))
     {
      g_lastOptions = GetTickCount();
      WriteOptions();
     }
  }

//+------------------------------------------------------------------+
//| Only one attached copy writes files (others stand by).           |
//+------------------------------------------------------------------+
bool IsWriter()
  {
   datetime now = TimeLocal();
   if(GlobalVariableCheck(OWNER_GV))
     {
      double cur = GlobalVariableGet(OWNER_GV);
      if(cur != g_token)
        {
         if(GlobalVariableCheck(OWNER_TS_GV) && now - (datetime)GlobalVariableGet(OWNER_TS_GV) <= 15) return false;
         if(!GlobalVariableSetOnCondition(OWNER_GV, g_token, cur)) return false;
        }
     }
   else
      GlobalVariableSet(OWNER_GV, g_token);
   if(GlobalVariableGet(OWNER_GV) != g_token) return false;
   GlobalVariableSet(OWNER_TS_GV, (double)now);
   return true;
  }

//+------------------------------------------------------------------+
bool IsOptionLike(string s)
  {
   int len = StringLen(s);
   if(len < 3 || StringFind(s, "_") < 0) return false;
   ushort c = StringGetCharacter(s, len - 1);
   return c >= '0' && c <= '9';
  }

void AddSymbol(string s)
  {
   for(int i = 0; i < ArraySize(g_symbols); i++) if(g_symbols[i] == s) return;
   int k = ArraySize(g_symbols);
   ArrayResize(g_symbols, k + 1);
   g_symbols[k] = s;
  }

void BuildSymbols()
  {
   ArrayResize(g_symbols, 0);
   AddSymbol(Symbol());
   string list = Symbols;
   StringTrimLeft(list); StringTrimRight(list);
   if(StringLen(list) > 0)
     {
      string parts[];
      int n = StringSplit(list, ',', parts);
      for(int i = 0; i < n; i++)
        {
         string s = parts[i];
         StringTrimLeft(s); StringTrimRight(s);
         if(StringLen(s) == 0) continue;
         if(MarketInfo(s, MODE_DIGITS) <= 0 && MarketInfo(s, MODE_BID) <= 0) { Print("TrendLensFeed: unknown symbol ", s); continue; }
         AddSymbol(s);
        }
     }
   else
     {
      int total = SymbolsTotal(true);
      for(int i = 0; i < total && ArraySize(g_symbols) < MaxSymbols; i++)
        {
         string s = SymbolName(i, true);
         if(!IsOptionLike(s)) AddSymbol(s);
        }
     }
  }

void BuildTimeframes()
  {
   string parts[];
   int n = StringSplit(Timeframes, ',', parts);
   ArrayResize(g_tfs, 0);
   for(int i = 0; i < n; i++)
     {
      int tf = (int)StringToInteger(parts[i]);
      if(tf != 1 && tf != 5 && tf != 15 && tf != 30 && tf != 60 && tf != 240 && tf != 1440 && tf != 10080 && tf != 43200) continue;
      int k = ArraySize(g_tfs);
      ArrayResize(g_tfs, k + 1);
      g_tfs[k] = tf;
     }
  }

//+------------------------------------------------------------------+
string Ts(datetime t) { return IntegerToString((long)t); }

string CandleFile(string sym, int tf) { return OUT_DIR + "candles_" + sym + "_" + IntegerToString(tf) + ".csv"; }

string CandleRow(string sym, int tf, int shift, string source)
  {
   int d = (int)MarketInfo(sym, MODE_DIGITS);
   return Ts(iTime(sym, tf, shift)) + "," + sym + "," + IntegerToString(tf) + "," +
          DoubleToString(iOpen(sym, tf, shift), d) + "," + DoubleToString(iHigh(sym, tf, shift), d) + "," +
          DoubleToString(iLow(sym, tf, shift), d) + "," + DoubleToString(iClose(sym, tf, shift), d) + "," +
          IntegerToString((long)iVolume(sym, tf, shift)) + "," + Ts(TimeCurrent()) + "," + source + "," + g_session;
  }

// Rewrites the candle file with the latest BackfillBars closed bars (temp file + rename).
bool Backfill(string sym, int tf)
  {
   int bars = iBars(sym, tf);
   int n = MathMin(BackfillBars, bars - 1);
   if(n <= 0) return false;                         // history not loaded yet; retried later
   string tmp = OUT_DIR + "tmp_" + sym + "_" + IntegerToString(tf) + ".csv";
   int h = FileOpen(tmp, FILE_WRITE | FILE_TXT | FILE_ANSI | FILE_COMMON);
   if(h == INVALID_HANDLE) return false;
   FileWriteString(h, CANDLE_HEADER + "\r\n");
   for(int i = n; i >= 1; i--) FileWriteString(h, CandleRow(sym, tf, i, "backfill") + "\r\n");
   FileClose(h);
   return FileMove(tmp, FILE_COMMON, CandleFile(sym, tf), FILE_COMMON | FILE_REWRITE);
  }

void BackfillPending()
  {
   g_lastRetry = TimeLocal();
   int ntf = ArraySize(g_tfs);
   for(int s = 0; s < ArraySize(g_symbols); s++)
      for(int t = 0; t < ntf; t++)
        {
         int idx = s * ntf + t;
         if(g_filled[idx]) continue;
         if(Backfill(g_symbols[s], g_tfs[t]))
           {
            g_filled[idx]  = true;
            g_lastBar[idx] = iTime(g_symbols[s], g_tfs[t], 0);
           }
        }
  }

void AppendClosed(string sym, int tf)
  {
   int h = FileOpen(CandleFile(sym, tf), FILE_READ | FILE_WRITE | FILE_TXT | FILE_ANSI | FILE_COMMON | FILE_SHARE_READ);
   if(h == INVALID_HANDLE) return;
   if(FileSize(h) == 0) FileWriteString(h, CANDLE_HEADER + "\r\n");
   FileSeek(h, 0, SEEK_END);
   FileWriteString(h, CandleRow(sym, tf, 1, "live") + "\r\n");
   FileClose(h);
  }

// Appends the bar that just closed whenever a new bar starts.
void Poll()
  {
   int ntf = ArraySize(g_tfs);
   for(int s = 0; s < ArraySize(g_symbols); s++)
      for(int t = 0; t < ntf; t++)
        {
         int idx = s * ntf + t;
         if(!g_filled[idx]) continue;
         datetime bar0 = iTime(g_symbols[s], g_tfs[t], 0);
         if(bar0 == 0 || bar0 == g_lastBar[idx]) continue;
         g_lastBar[idx] = bar0;
         AppendClosed(g_symbols[s], g_tfs[t]);
        }
  }

//+------------------------------------------------------------------+
//| Heartbeat: clocks, quotes and each TF's forming bar (shift 0).   |
//+------------------------------------------------------------------+
void WriteHeartbeat()
  {
   string q = "";
   for(int s = 0; s < ArraySize(g_symbols); s++)
     {
      string sym = g_symbols[s];
      int d = (int)MarketInfo(sym, MODE_DIGITS);
      string bars = "";
      for(int t = 0; t < ArraySize(g_tfs); t++)
        {
         int tf = g_tfs[t];
         datetime bt = iTime(sym, tf, 0);
         if(bt == 0) continue;
         if(StringLen(bars) > 0) bars += ",";
         bars += "{\"tf\":" + IntegerToString(tf) + ",\"time\":" + Ts(bt) +
                 ",\"o\":" + DoubleToString(iOpen(sym, tf, 0), d) + ",\"h\":" + DoubleToString(iHigh(sym, tf, 0), d) +
                 ",\"l\":" + DoubleToString(iLow(sym, tf, 0), d) + ",\"c\":" + DoubleToString(iClose(sym, tf, 0), d) +
                 ",\"v\":" + IntegerToString((long)iVolume(sym, tf, 0)) + "}";
        }
      if(s > 0) q += ",";
      q += "{\"symbol\":\"" + sym + "\",\"bid\":" + DoubleToString(MarketInfo(sym, MODE_BID), d) +
           ",\"ask\":" + DoubleToString(MarketInfo(sym, MODE_ASK), d) +
           ",\"last_tick_time\":" + Ts((datetime)MarketInfo(sym, MODE_TIME)) +
           ",\"digits\":" + IntegerToString(d) + ",\"bars\":[" + bars + "]}";
     }
   string js = "{\"feed\":\"TrendLensFeed\",\"version\":\"" + FEED_VERSION + "\",\"session\":\"" + g_session + "\"" +
               ",\"server_time\":" + Ts(TimeCurrent()) + ",\"local_time\":" + Ts(TimeLocal()) + ",\"gmt_time\":" + Ts(TimeGMT()) +
               ",\"connected\":" + (IsConnected() ? "true" : "false") + ",\"quotes\":[" + q + "]}";
   string tmp = OUT_DIR + "heartbeat.tmp";
   int h = FileOpen(tmp, FILE_WRITE | FILE_TXT | FILE_ANSI | FILE_COMMON);
   if(h == INVALID_HANDLE) return;
   FileWriteString(h, js);
   FileClose(h);
   FileMove(tmp, FILE_COMMON, OUT_DIR + "heartbeat.json", FILE_COMMON | FILE_REWRITE);
  }

//+------------------------------------------------------------------+
//| Option quotes: read-only MarketInfo of Market Watch symbols whose|
//| description names a call or put, plus the underlying prices.     |
//+------------------------------------------------------------------+
string JsonText(string s)
  {
   StringReplace(s, "\\", "\\\\");
   StringReplace(s, "\"", "\\\"");
   return "\"" + s + "\"";
  }

bool IsOptionDescription(string d)
  {
   return StringFind(d, " CE ") >= 0 || StringFind(d, " PE ") >= 0 || StringSubstr(d, StringLen(d) - 3) == " CE" || StringSubstr(d, StringLen(d) - 3) == " PE";
  }

string QuoteJson(string sym, string desc)
  {
   int d = (int)MarketInfo(sym, MODE_DIGITS);
   return "{\"s\":" + JsonText(sym) + ",\"d\":" + JsonText(desc) +
          ",\"b\":" + DoubleToString(MarketInfo(sym, MODE_BID), d) + ",\"a\":" + DoubleToString(MarketInfo(sym, MODE_ASK), d) +
          ",\"t\":" + Ts((datetime)MarketInfo(sym, MODE_TIME)) + ",\"pc\":" + DoubleToString(iClose(sym, PERIOD_D1, 1), d) +
          ",\"dg\":" + IntegerToString(d) + "}";
  }

void WriteOptions()
  {
   string opts = "";
   int total = SymbolsTotal(true);
   for(int i = 0; i < total; i++)
     {
      string sym = SymbolName(i, true);
      string desc = SymbolInfoString(sym, SYMBOL_DESCRIPTION);
      if(!IsOptionDescription(desc)) continue;
      if(StringLen(opts) > 0) opts += ",";
      opts += QuoteJson(sym, desc);
     }
   string unds = "";
   string parts[];
   int n = StringSplit(UnderlyingSymbols, ',', parts);
   for(int i = 0; i < n; i++)
     {
      string sym = parts[i];
      StringTrimLeft(sym); StringTrimRight(sym);
      if(StringLen(sym) == 0 || MarketInfo(sym, MODE_BID) <= 0) continue;
      if(StringLen(unds) > 0) unds += ",";
      unds += QuoteJson(sym, SymbolInfoString(sym, SYMBOL_DESCRIPTION));
     }
   // Skip the write when no price changed (still rewritten every 5 s so the app sees the feed is alive).
   string body = opts + "|" + unds;
   if(body == g_lastOptBody && GetTickCount() - g_lastOptWrite < 5000) return;
   g_lastOptBody  = body;
   g_lastOptWrite = GetTickCount();
   string js = "{\"feed\":\"TrendLensFeed\",\"version\":\"" + FEED_VERSION + "\"" +
               ",\"server_time\":" + Ts(TimeCurrent()) + ",\"gmt_time\":" + Ts(TimeGMT()) +
               ",\"connected\":" + (IsConnected() ? "true" : "false") +
               ",\"options\":[" + opts + "],\"underlyings\":[" + unds + "]}";
   string tmp = OUT_DIR + "options.tmp";
   int h = FileOpen(tmp, FILE_WRITE | FILE_TXT | FILE_ANSI | FILE_COMMON);
   if(h == INVALID_HANDLE) return;
   FileWriteString(h, js);
   FileClose(h);
   FileMove(tmp, FILE_COMMON, OUT_DIR + "options.json", FILE_COMMON | FILE_REWRITE);
  }
//+------------------------------------------------------------------+
