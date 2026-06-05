import assert from "node:assert/strict";
import test from "node:test";
import { planSvgImport } from "./svgWireImport.js";

const die = {
  id: "die-1",
  name: "die-1",
  originalFilename: "die.png",
  originalPath: "/tmp/die.png",
  width: 1000,
  height: 500,
  tileSize: 512,
  tileFormat: "jpg" as const,
  maxZoomLevel: 1,
  levels: [],
  createdAt: "",
  updatedAt: ""
};

test("plans SVG wire import using the background image coordinate frame", () => {
  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg">
      <g id="layer1">
        <image x="10" y="20" width="200" height="100" href="die.png" />
        <g id="WIRES" transform="translate(5,7)">
          <path inkscape:label="CLK" d="M 15 25 L 35 25" />
          <g inkscape:label="BUS">
            <path d="M 40 30 L 60 30" />
            <path d="M 60 30 L 60 50" />
          </g>
        </g>
      </g>
    </svg>
  `;

  const plan = planSvgImport({
    die,
    svg,
    svgPath: "/tmp/wires.svg",
    mode: "wires",
    namePrefix: "svg:"
  });

  assert.equal(plan.nets.length, 2);
  const clk = plan.nets[0];
  const bus = plan.nets[1];
  assert.equal(clk.name, "svg:CLK");
  assert.equal(bus.name, "svg:BUS");

  assert.equal(clk.nodes.length, 2);
  assert.equal(clk.nodes[0].x, 50);
  assert.equal(clk.nodes[0].y, 60);
  assert.equal(clk.nodes[1].x, 150);
  assert.equal(clk.nodes[1].y, 60);
  assert.equal(clk.edges.length, 1);
  assert.equal(clk.edges[0].from, clk.nodes[0].id);
  assert.equal(clk.edges[0].to, clk.nodes[1].id);

  assert.equal(bus.nodes.length, 3);
  assert.equal(bus.edges.length, 2);
  assert.equal(bus.edges[0].from, bus.nodes[0].id);
  assert.equal(bus.edges[0].to, bus.nodes[1].id);
  assert.equal(bus.edges[1].from, bus.nodes[1].id);
  assert.equal(bus.edges[1].to, bus.nodes[2].id);
});

test("plans SVG cell import grouped by type from CELLS ids", () => {
  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg">
      <g id="layer1">
        <image x="10" y="20" width="200" height="100" href="die.png" />
        <g inkscape:label="CELLS" transform="translate(5,7)">
          <rect id="P_87_2_D24" x="15" y="25" width="20" height="10" />
          <rect id="Q_88_2_D24" x="45" y="35" width="20" height="10" />
          <rect id="R_90_13_LT4" x="75" y="40" width="20" height="30" />
        </g>
      </g>
    </svg>
  `;

  const plan = planSvgImport({
    die,
    svg,
    svgPath: "/tmp/cells.svg",
    mode: "cells",
    namePrefix: "svg:"
  });

  assert.equal(plan.cellTypes.length, 2);
  assert.deepEqual(
    plan.cellTypes.map((entry) => [entry.name, entry.instanceCount]),
    [
      ["svg:13_LT4", 1],
      ["svg:2_D24", 2]
    ]
  );

  assert.equal(plan.cells.length, 3);
  assert.deepEqual(plan.cells[0], {
    sourceId: "P_87_2_D24",
    typeKey: "svg:2_d24",
    baseTypeName: "svg:2_D24",
    typeName: "svg:2_D24",
    x: 50,
    y: 60,
    width: 100,
    height: 50,
    column: "P",
    row: 87,
    snappedColumn: null,
    snappedRow: null
  });
  assert.deepEqual(plan.cells[2], {
    sourceId: "R_90_13_LT4",
    typeKey: "svg:13_lt4",
    baseTypeName: "svg:13_LT4",
    typeName: "svg:13_LT4",
    x: 350,
    y: 135,
    width: 100,
    height: 150,
    column: "R",
    row: 90,
    snappedColumn: null,
    snappedRow: null
  });
});

test("plans SVG cell import using ident_cells row and column classification", () => {
  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg">
      <g id="layer1">
        <image x="0" y="0" width="1000" height="1000" href="die.png" />
        <g inkscape:label="CELLS">
          <rect id="P_87_unknown" x="-3633" y="-3256.87" width="138" height="${624.845 / 11}" />
        </g>
      </g>
    </svg>
  `;

  const plan = planSvgImport({
    die,
    svg,
    svgPath: "/tmp/cells.svg",
    mode: "cells",
    namePrefix: "",
    cellClassification: {
      chip: "ic19",
      preset: {
        cellsStartX: -3633,
        cellsStartY: -3256.87,
        cellWidthWithMargin: 349,
        cellHeight: 624.845 / 11
      },
      typeByInstanceKey: new Map([["ic19_0_0", "1_V2B"]])
    }
  });

  assert.equal(plan.cellTypes.length, 1);
  assert.equal(plan.cellTypes[0].name, "1_V2B");
  assert.equal(plan.cells[0].typeName, "1_V2B");
  assert.equal(plan.cells[0].snappedColumn, 0);
  assert.equal(plan.cells[0].snappedRow, 0);
});
