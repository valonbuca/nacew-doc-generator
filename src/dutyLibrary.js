// Local library of Albanian job duties (Neni 3), keyed by position title and
// matched case-insensitively. Lets a contract be generated with zero API
// calls for positions we've already written duties for; anything else falls
// back to the API (online) or blank editable rows (offline) -- see
// getJobDuties() in DocForm.jsx.
const DUTY_LIBRARY = {
  "ui/ux designer": [
    "Ridizajnimi i UI/UX i platformës ekzistuese dhe veçorive të reja për web & mobil",
    "Krijimi, mirëmbajtja dhe zgjerimi i sistemit të dizajnit (design system)",
    "Strukturimi i UI komponentëve në mënyrë që të jenë të lexueshme nga inteligjenca artificiale (AI)",
    "Kryerja e testimeve të përdorshmërisë me përdorues real",
    "Bashkëpunimi i ngushtë me ekipin e zhvillimit për implementimin e dizajnit",
  ],
  "sales lead": [
    "Identifikimi dhe kualifikimi i klientëve potencialë (leads)",
    "Zhvillimi dhe mbajtja e marrëdhënieve afatgjata me klientët",
    "Përgatitja dhe dorëzimi i propozimeve dhe ofertave komerciale",
    "Menaxhimi i pipeline-it të shitjeve në sistemin CRM",
    "Raportimi mujor i performancës së shitjeve te menaxhmenti",
  ],
  "qa automation engineer": [
    "Krijimi dhe mirëmbajtja e testeve automatike për platformën",
    "Ekzekutimi i testeve regresive para çdo lëshimi (release)",
    "Identifikimi dhe raportimi i defekteve në sistemin e ndjekjes së çështjeve",
    "Integrimi i testeve automatike në pipeline-in CI/CD",
    "Bashkëpunimi me zhvilluesit për zgjidhjen e problemeve të gjetura",
  ],
  "product owner": [
    "Përcaktimi dhe prioritizimi i listës së kërkesave (backlog)",
    "Shkrimi i kërkesave dhe kritereve të pranimit për çdo veçori",
    "Bashkëpunimi me palët e interesuara për përcaktimin e vizionit të produktit",
    "Vlerësimi dhe pranimi i punës së përfunduar nga ekipi i zhvillimit",
    "Analizimi i të dhënave të përdorimit për vendime produkti",
  ],
  "software developer": [
    "Zhvillimi dhe mirëmbajtja e veçorive të reja në platformë",
    "Shkrimi i kodit të pastër, të testueshëm dhe të dokumentuar",
    "Rishikimi i kodit (code review) të kolegëve në ekip",
    "Diagnostikimi dhe zgjidhja e problemeve (bug-ve) të raportuara",
    "Bashkëpunimi me ekipin e dizajnit për implementimin e ndërfaqes",
  ],
  "motion designer": [
    "Krijimi i animacioneve dhe videove për platforma digjitale",
    "Zhvillimi i storyboard-eve për projektet e reja",
    "Përgatitja e aseteve grafike të animuara për web & mobil",
    "Bashkëpunimi me ekipin krijues për konceptet vizuale",
    "Përshtatja e animacioneve sipas identitetit të markës",
  ],
};

// Returns a fresh copy of the library's duties for a position, or null if
// the position isn't in the library (case/whitespace-insensitive match).
export function findDutiesForPosition(position) {
  const key = String(position || "").trim().toLowerCase();
  if (!key || !DUTY_LIBRARY[key]) return null;
  return [...DUTY_LIBRARY[key]];
}
