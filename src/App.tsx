import { AppProvider, browserStorage, useApp } from "./app/store";
import { CampaignResults } from "./ui/CampaignResults";
import { FormulaDetails } from "./ui/FormulaDetails";
import { Header } from "./ui/Header";
import { HowItWorks } from "./ui/HowItWorks";
import { JournalHistory } from "./ui/JournalHistory";
import { ModelMemory } from "./ui/ModelMemory";
import { ModelReading } from "./ui/ModelReading";
import { ModelSettings } from "./ui/ModelSettings";
import { Observer } from "./ui/Observer";
import { ResultsDetails } from "./ui/ResultsDetails";
import { TradeTicket } from "./ui/TradeTicket";

const storage = browserStorage();

function Console() {
  const { state } = useApp();
  return (
    <div className="cp-app">
      <Header />
      {(["manual", "paper"] as const).map((m) =>
        state.loadErrors[m] ? (
          <p key={m} className="cp-banner" role="alert">
            Stored {m} ledger was not loaded: {state.loadErrors[m]}. It has not been modified or reset; this session shows an empty {m} ledger and will not overwrite the stored one.
          </p>
        ) : null,
      )}
      {state.configError && <p className="cp-banner" role="alert">{state.configError}</p>}
      {state.engineError && <p className="cp-banner" role="alert">{state.engineError}</p>}
      {state.storageKind === "memory" && <p className="cp-banner">localStorage unavailable: ledgers persist only for this session.</p>}
      <div className="cp-layout">
        <Observer />
        <div className="cp-right">
          <ModelReading />
          <TradeTicket />
          <CampaignResults />
        </div>
      </div>
      <p className="cp-notice" aria-live="polite">{state.notice ?? "One position at a time per mode · Synthetic inputs · Stops shown here are not broker orders · Score, not probability."}</p>
      <HowItWorks selectedRoot={state.selectedRoot} />
      <FormulaDetails />
      <JournalHistory />
      <ModelSettings />
      <ModelMemory />
      <ResultsDetails />
    </div>
  );
}

export function App() {
  return (
    <AppProvider storage={storage}>
      <Console />
    </AppProvider>
  );
}
