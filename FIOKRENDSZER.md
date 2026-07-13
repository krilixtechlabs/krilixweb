# Krilix admin fiókrendszer

## Első indítás Railwayen

A rendszer az első induláskor automatikusan létrehozza az első **Tulajdonos** fiókot, amennyiben az `admin_users` tábla még üres.

Állítsd be ezeket a Railway Variables részben:

```env
ADMIN_NAME=Kristóf
ADMIN_EMAIL=sajat-email-cimed@gmail.com
ADMIN_PASSWORD=legalabb-10-karakteres-eros-jelszo
```

Az `ADMIN_EMAIL` lehet a saját személyes email címed. Ez kizárólag az admin belépéshez használatos, és nem jelenik meg a nyilvános weboldalon. A kapcsolatfelvételi cím ettől külön marad:

```env
CONTACT_TO_EMAIL=hello@krilixtechlabs.com
```

Fontos: az `ADMIN_EMAIL` vagy `ADMIN_PASSWORD` későbbi átírása nem módosítja automatikusan a már létrejött fiókot. A jelszót az adminfelületen kell megváltoztatni.

## Belépés

Az adminfelület címe:

```text
/admin
```

Belépéshez minden munkatárs a saját email címét és jelszavát használja.

## Új fiók létrehozása

1. Jelentkezz be a tulajdonosi fiókkal.
2. Nyisd meg a **Fiókok** menüpontot.
3. Kattints az **Új fiók** gombra.
4. Add meg a nevet, email címet, szerepkört és egy ideiglenes jelszót.
5. Az új felhasználónak az első belépéskor kötelező saját jelszót beállítania.

Publikus regisztráció nincs. Új adminfiókot csak megfelelő jogosultsággal rendelkező felhasználó hozhat létre.

## Szerepkörök

- **Tulajdonos:** teljes hozzáférés, fiókok és jogosultságok kezelése.
- **Adminisztrátor:** napi adminisztráció, briefek, üzenetek és ügyféladatok kezelése.
- **Projektmenedzser:** briefek, ügyfélkommunikáció és projektek kezelése törlési jog nélkül.
- **Értékesítés:** érdeklődők, briefek, ajánlatkérések és ügyfélkapcsolatok kezelése.
- **Fejlesztő:** projekt- és technikai adatok kezelése, korlátozott ügyfélhozzáférés.
- **Megtekintő:** csak olvasási hozzáférés.

A szerepkörök mellett minden fióknál külön engedélyezhető vagy letiltható egy-egy jogosultság.

## Biztonság

- A jelszavak `scrypt` hash formában kerülnek az adatbázisba.
- A munkamenetek véletlenszerű tokennel és adatbázisban tárolva működnek.
- A munkamenet-cookie `HttpOnly`, `SameSite=Strict`, HTTPS esetén pedig `Secure`.
- A sikertelen belépési próbálkozások korlátozva vannak.
- A letiltott fiók aktív munkamenetei azonnal megszűnnek.
- Jelszócsere után a többi eszközön futó munkamenetek törlődnek.
- A fontos adminműveletek tevékenységnaplóba kerülnek.
- Legalább egy aktív tulajdonosi fióknak mindig maradnia kell.
- Tulajdonosi fiókot csak tulajdonos hozhat létre vagy módosíthat.

## Automatikusan létrejövő adatbázistáblák

- `admin_users`
- `admin_sessions`
- `admin_audit_log`

A meglévő briefek, ajánlatkérések és beszélgetések változatlanul megmaradnak.
