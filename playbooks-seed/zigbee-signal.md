# Slabý Zigbee signál — jak ho oživit

> Playbook pro Žána. Postupy jsou seřazené od nejúčinnějšího a nejlevnějšího.
> Když najdeš zařízení s LQI pod 80, projdi je shora dolů.
>
> **Zdroj:** obecně ověřené postupy pro Zigbee sítě (stav 8/2026).
> Postupy z české HA komunity se sem doplní z probíhajícího miningu FB skupiny
> a HA fóra — do té doby ber tenhle seznam jako základ, ne jako úplný.

## Nejdřív změř, pak jednej

- **LQI (0–255)** = kvalita spoje. Pod 30 na hraně, pod 80 slabé, 150+ dobré.
- **RSSI (dBm)** = síla signálu. −80 a horší je slabé, −60 a lepší je dobré.
- **Důležité:** LQI se měří **k sousedovi**, ne ke koordinátoru. Zařízení s LQI 200
  může být na konci dlouhého řetězu a přesto vypadávat — kouká se i na to, přes koho jede.
- **Router vs EndDevice:** napájená zařízení (zásuvky, relé, žárovky) jsou obvykle
  **routery** a signál opakují. Bateriová (čidla, tlačítka) jsou **EndDevice** a
  neopakují nic. Přidat další čidlo síť neposílí — přidat zásuvku ano.

## 1. Přepárovat zařízení na jeho místě (nejčastější a nejlevnější oprava)

Zigbee zařízení si při párování zvolí „rodiče" a **drží se ho**, i když se mezitím
přestěhuje nebo se objeví bližší router. Když se párovalo vedle koordinátoru a pak se
odneslo do sklepa, jede pořád přes původní trasu a vypadává.

**Postup:** zařízení nech tam, kde má být → otevři párování → resetuj zařízení →
spáruje se znovu a najde si nejbližší router. **Nikdy nepárovat vedle koordinátoru
a pak odnášet.**

Tohle řeší i případ „fungovalo to, a najednou ne" — když se rodičovský router odpojil,
sirotek se sám nepřipojí vždycky správně.

## 2. Přidat router (Zigbee zásuvku) mezi bránu a problémové zařízení

Nejúčinnější trvalé řešení. Levná Zigbee zásuvka do zásuvky v půli cesty prodlouží síť
všem zařízením v okolí, ne jen jednomu.

- Umísti ji **mezi** bránu a slabé zařízení, ne až za něj.
- Pozor na levné starší Tuya zásuvky — některé mají malou tabulku sousedů (drží jen
  pár dětí) a pod zátěží zapomínají. Osvědčenější jsou IKEA, SONOFF, Aqara routery.
- Po přidání routeru **nech síť pár hodin ustálit**, případně slabé zařízení přepáruj
  (viz bod 1), aby si nový router vzalo za rodiče.

## 3. Odstranit rušení od WiFi a USB 3.0

Zigbee i WiFi jedou na 2,4 GHz a perou se.

- **Koordinátor nikdy nezapichovat přímo do USB portu vedle SSD nebo USB 3.0 disku.**
  Použij **USB prodlužovačku (0,5–2 m)** a dej ho stranou od počítače — tohle samo
  o sobě často zvedne LQI o desítky bodů. Je to nejčastěji podceňovaná příčina.
- Drž koordinátor dál od WiFi routeru, rozvaděče, kovové skříně a betonu.
- Kovová rozvodnice = klec; anténa musí ven.

## 4. Sladit Zigbee kanál s WiFi

Zigbee kanály 15, 20, 25 leží mimo nejpoužívanější WiFi kanály 1, 6, 11.

- Zjisti, na jakém kanálu jede WiFi, a Zigbee dej mimo něj.
- **Varování, které musíš člověku říct dopředu:** změna Zigbee kanálu znamená, že se
  **část zařízení bude muset přepárovat** (hlavně bateriová). Není to nevinné kliknutí —
  navrhuj to až po bodech 1–3.

## 5. Zkontrolovat baterii

Skoro vybité čidlo vysílá slabě a vypadává, i když se nic v síti nezměnilo.
Když má zařízení slabý signál **a zároveň** nízkou baterii, začni baterií — je to
levnější než přestavovat síť.

## 6. Fyzické umístění

- Ne do kovové krabice, ne za velké spotřebiče (lednice, myčka, bojler).
- Ne přímo na zem a ne za zrcadlo (pokovená vrstva odráží).
- Ideálně výš a s přímějším výhledem k nejbližšímu routeru.
- Železobetonový strop je pro Zigbee těžší překážka než dvě sádrokartonové příčky —
  mezi patry se skoro vždy vyplatí router.

## 7. Firmware a stabilita brány

- Zastaralý firmware koordinátoru umí dělat náhodné výpadky celé sítě.
- Když vypadává **víc zařízení naráz a napříč domem**, není to jejich dosah — hledej
  příčinu u koordinátoru (rušení, napájení, firmware, USB port).

---

## Jak to Žán použije v praxi

1. Při obchůzce najdi zařízení s LQI pod 80 a **spoj to s tím, jestli vypadává.**
2. Rozliš **dosah od poruchy**: slabý signál → body 1–4 a 6; silný signál a přesto mimo
   → baterie (bod 5) nebo vada zařízení, přesouvat nemá smysl.
3. Když je slabých zařízení víc a síť má **málo routerů**, je to **jedna systémová
   příčina** — navrhni jednu zásuvku navíc, ne pět přesunů.
4. Při otevírání párování **vždycky** řekni, které zařízení mělo nejhorší signál, a
   připomeň bod 1: nepárovat u brány a pak odnášet.
5. Co vyžaduje ruce (přesun, baterie, nová zásuvka), řekni konkrétně a stručně —
   tohle za člověka neuděláš.
6. Změnu kanálu (bod 4) navrhuj až jako poslední a **vždy s varováním o přepárování**.
