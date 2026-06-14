;;
;; mmo-chip Layout Import — Cadence SKILL script
;;
;; Usage in Virtuoso:
;;   1. Import the SPICE netlist (creates schematic + layout cells)
;;   2. Open the target layout cell
;;   3. Load this script: load("mmo_chip_place.il")
;;   4. Run: mmoChipPlace("placement.csv")
;;
;; The script reads a CSV file with format:
;;   instance,x_um,y_um,rotation,kind,params
;;
;; For each line, it finds the master cell by kind (e.g. "resistor_gen")
;; and creates an instance at (x_um, y_um) with the given rotation.
;;
;; NOTE: Adjust *masterCellMap* to match your PDK cell names.
;;

; ── Configuration ────────────────────────────────────────────────

; Map mmo-chip device kinds to your PDK master cell names.
; Edit these to match your library.
masterCellMap = nil
when(!masterCellMap
  masterCellMap = list(
    list("mos"      "NMOS_VTL")
    list("bjt_npn"  "NPN_10x10")
    list("bjt_pnp"  "PNP_10x10")
    list("resistor" "RES_POLY")
    list("capacitor" "CAP_MIM")
    list("diode"     "DIODE_PN")
  )
)

; Library name where master cells reside
libName = "my_analog_lib"

; ── Parser ───────────────────────────────────────────────────────

procedure(mmoChipParseCsv(filePath)
  let((port line fields result)
    port = infile(filePath)
    unless(port error("Cannot open %s\n" filePath))
    result = nil
    while(gets(line port)
      line = buildString(parseString(line "\n") "")
      when(line != "" && substr(line 0 2) != "//"
        fields = parseString(line ",")
        when(length(fields) >= 4
          result = cons(list(
            nth(0 fields)    ; instance name
            atof(nth(1 fields)) ; x [um]
            atof(nth(2 fields)) ; y [um]
            nth(3 fields)    ; rotation (R0/R90/R180/R270)
            nth(4 fields)    ; kind
            nth(5 fields)    ; params (optional)
          ) result)
        )
      )
    )
    close(port)
    reverse(result)
  )
)

; ── Placement ─────────────────────────────────────────────────────

procedure(mmoChipPlace(csvPath)
  let((entries entry instName x y rot kind params master transform cv)
    cv = geGetEditCellView()
    unless(cv error("No layout cell view open.\n"))

    entries = mmoChipParseCsv(csvPath)
    printf("mmoChipPlace: placing %d devices...\n" length(entries))

    foreach(entry entries
      instName = car(entry)
      x = cadr(entry)
      y = caddr(entry)
      rot = cadddr(entry)
      kind = nth(4 entry)
      params = nth(5 entry)

      ; Look up master cell
      master = assoc(kind masterCellMap)
      unless(master
        printf("  WARNING: no master cell for kind '%s' (%s)\n" kind instName)
        continue
      )
      master = cadr(master)

      ; Build transform list: (R0 -> "R0", R90 -> "R90")
      rotStr = rot
      unless(member(rotStr '("R0" "R90" "R180" "R270"))
        rotStr = "R0"
      )

      ; Convert rotation string to SKILL transform
      transform = list(
        x * 1.0       ; x origin [um] — Cadence uses microns
        y * 1.0       ; y origin [um]
        "R0"          ; magnification — not implemented
        rotStr        ; orientation
      )

      ; Create instance
      inst = dbCreateInst(cv (list libName master "layout") instName transform)
      if(inst
        printf("  placed %s %s at (%.2f, %.2f) %s\n" kind instName x y rotStr)
      else
        printf("  ERROR: failed to create %s (%s) at (%.2f, %.2f)\n" instName kind x y)
      )
    )
    printf("mmoChipPlace: done.\n")
  )
)

; ── Help ──────────────────────────────────────────────────────────

procedure(mmoChipHelp()
  printf("mmo-chip Layout Import Helper\n")
  printf("==============================\n")
  printf("1. mmoChipPlace(\"<csv_path>\") — place all instances\n")
  printf("2. Edit masterCellMap to match your PDK\n")
  printf("\n")
)
