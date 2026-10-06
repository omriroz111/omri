# Dvir Clicker for Android

Wraps the web game in `../dvir-clicker` in a full-screen, portrait-only WebView app
(`com.omri.dvirclicker`, Android 7.0+). The game ships inside the APK, so it works
offline and the app asks for no permissions besides vibration.

`DvirClicker.apk` is the ready-to-install build.

## Rebuild

```sh
sudo apt-get install aapt dalvik-exchange zipalign apksigner   # plus a JDK
./build.sh
```

`build.sh` copies `../dvir-clicker` into the APK, so rebuild after changing the game.
Run `python3 make_icons.py` to regenerate the launcher icons from `../dvir-clicker/dvir.webp`.

## Signing

`dvir-clicker.keystore` (password in `build.sh`) signs every build, so a new APK installs
over the old one and keeps saved progress. It is only meant for sideloading; use a new,
private key if the app ever goes to the Play Store.
