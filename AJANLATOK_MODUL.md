# KRILIX – Ajánlatok modul

Az Ajánlatok modul a meglévő KRILIX admin és PostgreSQL adatbázis része.
Nem külön Railway projekt.

## Admin

Nyisd meg:

`/admin`

Új bal oldali menüpont:

`Ajánlatok`

Funkciók:

- új ajánlat létrehozása
- ajánlat készítése közvetlenül egy briefből
- ajánlat készítése egy beérkezett ajánlatkérésből
- ügyféllogó feltöltése
- ügyfél akcentusszín beállítása
- funkciók szerkesztése
- tételes árazás
- automatikus végösszeg
- ütemezés és feltételek
- piszkozat mentése
- admin előnézet
- publikálás / visszavonás
- publikus link másolása
- ajánlat másolása
- megtekintésszám
- ügyfél általi elfogadás

## Publikus URL

A publikált ajánlatok ugyanazon a KRILIX alkalmazáson belül érhetők el:

`https://krilixtechlabs.com/ajanlat/vibehouse`

A slug az adminból módosítható.

## PDF

Nincs külön, kézzel karbantartott PDF fájl.
A publikus ajánlat `PDF / nyomtatás` gombja ugyanabból az aktuális ajánlatból készít nyomtatható változatot.
Így az ár és a tartalom nem tud eltérni a webes ajánlattól.

## Elfogadás

Az ügyfél megadja:

- nevét
- e-mail címét
- elfogadja a rögzített összeget és feltételeket

A rendszer PostgreSQL-ben elmenti:

- elfogadás időpontja
- név
- e-mail
- IP
- user-agent
- az elfogadás pillanatában érvényes ajánlat snapshotja

Az ajánlat státusza `accepted` lesz, és az elfogadott ajánlat zárolódik.
Ha Resend konfigurálva van, a KRILIX és az ügyfél is kap visszaigazoló e-mailt.

## Adatbázis

A szerver induláskor automatikusan létrehozza a szükséges táblákat:

- `quotes`
- `quote_acceptances`

Külön migration parancs nem szükséges.

## Jogosultságok

Új jogosultságok:

- `quotes.read`
- `quotes.write`
- `quotes.publish`
- `quotes.delete`

Ezek a meglévő admin szerepkör-rendszerben is megjelennek.

## Vibe House

Ha még nincs `vibehouse` slugú ajánlat az adatbázisban, a rendszer első induláskor létrehozza a Vibe House 140 000 Ft-os mintaajánlatát.

## Railway frissítés

A meglévő KRILIX Railway service-be ezt a projektet kell feltölteni / pusholni.
A meglévő környezeti változók használhatók tovább:

- DATABASE_URL
- BASE_URL
- RESEND_API_KEY
- CONTACT_FROM_EMAIL
- CONTACT_TO_EMAIL
- admin változók

Új kötelező environment variable nincs.
