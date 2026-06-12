#!/usr/bin/env python
# coding=utf-8
#
# Copyright (C) 2015 ~suv <suv-sf@users.sf.net>
# Copyright (C) 2010 Alvin Penner
# Copyright (C) 2006 Georg Wiora
# Copyright (C) 2006 Nathan Hurst
# Copyright (C) 2005 Aaron Spike, aaron@ekips.org
#
# This program is free software; you can redistribute it and/or modify
# it under the terms of the GNU General Public License as published by
# the Free Software Foundation; either version 2 of the License, or
# (at your option) any later version.
#
# This program is distributed in the hope that it will be useful,
# but WITHOUT ANY WARRANTY; without even the implied warranty of
# MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
# GNU General Public License for more details.
#
# You should have received a copy of the GNU General Public License
# along with this program; if not, write to the Free Software
# Foundation, Inc., 51 Franklin Street, Fifth Floor, Boston, MA  02110-1301, USA.
#
"""
This extension module can measure arbitrary path and object length
It adds text to the selected path containing the length in a given unit.
Area and Center of Mass calculated using Green's Theorem:
http://mathworld.wolfram.com/GreensTheorem.html
"""

import inkex
from inkex import TextElement, TextPath, Tspan
from inkex.bezier import csparea, cspcofm, csplength
from inkex.localization import inkex_gettext as _

class MeasureLength(inkex.EffectExtension):
    """Measure the length of selected paths"""

    def add_arguments(self, pars):
        # text position
        pars.add_argument("--type", dest="mtype", default="length", help="Type of measurement")
        pars.add_argument("--method", type=self.arg_method(), default=self.method_textonpath, help="Text Orientation method")
        pars.add_argument("--presetFormat", default="default", help="Preset text layout")
        pars.add_argument("--startOffset", default="custom", help="Text Offset along Path")
        pars.add_argument("--startOffsetCustom", type=int, default=50, help="Text Offset along Path")
        pars.add_argument("--anchor", default="start", help="Text Anchor")
        pars.add_argument("--position", default="start", help="Text Position")
        pars.add_argument("--angle", type=float, default=0, help="Angle")
        
        # common arguments
        pars.add_argument("--notebookType", type=str, help="This argument do nothing")
        pars.add_argument("--wrfile", type=str, default="false", help="Write results to file")
        pars.add_argument("--pathToFile", type=str, default=" ", help="Path to output file")
        pars.add_argument("-f", "--fontsize", type=int, default=12, help="Size of length label text in px")
        pars.add_argument("-o", "--offset", type=float, default=-6, help="The distance above the curve")
        pars.add_argument("-p", "--precision", type=int, default=2, help="Number of significant digits after decimal point")
        pars.add_argument("-s", "--scale", type=float, default=1.0, help="Scale Factor (Drawing:Real Length)")
        
        # arguments for length and area measure
        pars.add_argument("-u", "--unit", default="px", help="The unit of the measurement")
        
        # arguments for resistance measure
        pars.add_argument("--widthManual", type=float, default=0.0, help="Manual resistor width")
        pars.add_argument("--resUnit", default="Ohms", help="The unit of the resistance measurement")
        pars.add_argument("--sqres", type=float, default=0.0, help="Resistana per square")
        pars.add_argument("--twists", type=int, default=0, help="Number of twists")
        
        # arguments for capacitance measure
        pars.add_argument("--specap", type=float, default=0.0, help="Specific capacitance")
        
        # arguments for npn measure
        pars.add_argument("--s0npn", type=float, default=0.0, help="S0 for npn")
        
        # arguments for pnp measure
        pars.add_argument("--p0pnp", type=float, default=0.0, help="P0 for pnp")

    def effect(self):
        # get number of digits
        prec = int(self.options.precision)
        scale = self.svg.viewport_to_unit(
            "1" + self.svg.document_unit
        )  # convert to document units
        self.options.offset *= scale

        factor = self.svg.unit_to_viewport(1, self.options.unit)
        
        # writing to file
        if self.options.wrfile == "true":
            file = open(self.options.pathToFile, 'w')
            file.write(f"self.svg.viewport_to_unit: {self.svg.viewport_to_unit}\n")
            file.write(f"self.svg.document_unit: {self.svg.document_unit}\n")
            file.write(f"scale: {scale}\n")
            file.write(f"factor: {factor}\n\n")

        # loop over all selected paths
        filtered = self.svg.selection.filter(inkex.PathElement)
        if not filtered:
            raise inkex.AbortExtension(_("Please select at least one path object."))
        for node in filtered:
            csp = node.path.transform(node.composed_transform()).to_superpath()
            inverse_parent_transform = -node.getparent().composed_transform()
            
            if self.options.mtype == "length":
                slengths, stotal = csplength(csp)
                self.group = node.getparent().add(TextElement())
                val = round(stotal * factor * self.options.scale, prec)
                
            elif self.options.mtype == "area":
                stotal = abs(csparea(csp) * factor * self.options.scale)
                self.group = node.getparent().add(TextElement())
                val = round(stotal * factor * self.options.scale, prec)
            
            elif self.options.mtype == "resManual":
                slengths, stotal = csplength(csp)
                self.group = node.getparent().add(TextElement())	
                if self.options.resUnit == "Ohms":
                    val = round(self.options.sqres * ((stotal - 2 * self.options.widthManual) / 2 / self.options.widthManual - 0.45 * self.options.twists), prec)
                elif self.options.resUnit == "[]":
                    val = round((stotal - 2 * self.options.widthManual) / 2 / self.options.widthManual - 0.45 * self.options.twists, prec)
                if self.options.wrfile == "true":
                    file.write(f"stotal: {csp}\n")
                    file.write(f"slengths: {slengths}\n")
                    file.write(f"widthManual: {self.options.widthManual}\n\n")
            
            elif self.options.mtype == "res1":
                slengths, stotal = csplength(csp)
                # width = min(slengths[0])
                positive_lengths = [length for length in slengths[0] if length > 0]
                width = min(positive_lengths)
                self.group = node.getparent().add(TextElement())	
                if self.options.resUnit == "Ohms":
                    val = round(self.options.sqres * ((stotal - 2 * width) / 2 / width - 0.45 * self.options.twists), prec)
                elif self.options.resUnit == "[]":
                    val = round((stotal - 2 * width) / 2 / width - 0.45 * self.options.twists, prec)
                if self.options.wrfile == "true":
                    file.write(f"stotal: {csp}\n")
                    file.write(f"slengths: {slengths}\n")
                    file.write(f"width: {width}\n\n")
            
            elif self.options.mtype == "res2":
                slengths, stotal = csplength(csp)
                width = float(node.style['stroke-width'])
                self.group = node.getparent().add(TextElement())
                if self.options.resUnit == "Ohms":
                    val = round(self.options.sqres * ((stotal - self.options.twists * width) / width + 0.55 * self.options.twists), prec)
                elif self.options.resUnit == "[]":
                    val = round((stotal - self.options.twists * width) / width + 0.55 * self.options.twists, prec)
                if self.options.wrfile == "true":
                    file.write(f"stroke-width: {width}\n")
                    file.write(f"stotal: {csp}\n")
                    file.write(f"slengths: {slengths}\n")
                    file.write(f"width: {width}\n\n")
            
            elif self.options.mtype == "cap":
                self.options.unit = "pF"
                stotal = abs(csparea(csp))
                self.group = node.getparent().add(TextElement())
                val = round(stotal * self.options.specap / pow(10, 3), prec)
                if self.options.wrfile == "true":
                    file.write(f"stotal: {stotal}\n")
                    file.write(f"self.options.scale: {self.options.scale}\n")
                    file.write(f"val: {val}\n\n")
                
            elif self.options.mtype == "npn":
                self.options.unit = ""
                stotal = abs(csparea(csp))
                self.group = node.getparent().add(TextElement())
                val = round((stotal / self.options.s0npn) * self.options.scale, prec)
                if self.options.wrfile == "true":
                    file.write(f"stotal: {stotal}\n\n")
                
            elif self.options.mtype == "pnp":
                self.options.unit = ""
                slengths, stotal = csplength(csp)
                self.group = node.getparent().add(TextElement())
                val = round((stotal / self.options.p0pnp) * self.options.scale, prec)
                if self.options.wrfile == "true":
                    file.write(f"stotal: {stotal}\n\n")
            
            self.options.method(node, str(val))
            
        if self.options.wrfile == "true":
            file.close()

    def method_textonpath(self, node, lenstr):
        startOffset = self.options.startOffset
        if startOffset == "custom":
            startOffset = str(self.options.startOffsetCustom) + "%"
        if self.options.mtype == "length":
            self.add_textonpath(
                self.group,
                0,
                0,
                lenstr + " " + self.options.unit,
                node,
                self.options.anchor,
                startOffset,
                self.options.offset,
            )
        else:
            self.add_textonpath(
                self.group,
                0,
                0,
                lenstr + " " + self.options.unit + "^2",
                node,
                self.options.anchor,
                startOffset,
                self.options.offset,
            )

    def method_fixedtext(self, node, lenstr):
        _id = node.get("id")
        csp = node.path.transform(node.composed_transform()).to_superpath()
        if self.options.position == "mass":
            tx, ty = cspcofm(csp)
            anchor = "middle"
        elif self.options.position == "center":
            bbox = node.bounding_box(True)
            tx, ty = bbox.center
            anchor = "middle"
        else:  # default
            tx = csp[0][0][1][0]
            ty = csp[0][0][1][1]
            anchor = "start"
        if self.options.mtype in {"length", "cap", "npn", "pnp"}:
            self.add_fixedtext(
                self.group,
                tx,
                ty,
                lenstr + " " + self.options.unit,
                anchor,
                -int(self.options.angle),
                -self.options.offset + self.options.fontsize / 2,
            )
        elif self.options.mtype in {"resManual", "res1", "res2"}:
            self.add_fixedtext(
                self.group,
                tx,
                ty,
                lenstr + " " + self.options.resUnit,
                anchor,
                -int(self.options.angle),
                -self.options.offset + self.options.fontsize / 2,
            )
        else:
            self.add_fixedtext(
                self.group,
                tx,
                ty,
                lenstr + " " + self.options.unit + "^2",
                anchor,
                -int(self.options.angle),
                -self.options.offset + self.options.fontsize / 2,
            )

    def method_presets(self, node, lenstr):
        """A preset option for alignments"""
        preset_dict = {
            "default_res2": [self.method_textonpath, "50%", "start", None, None],
            "default_res1": [self.method_textonpath, "50%", "start", None, None],
            "default_length": [self.method_textonpath, "50%", "start", None, None],
            "TaP_start": [self.method_textonpath, "0%", "start", None, None],
            "TaP_middle": [self.method_textonpath, "50%", "middle", None, None],
            "TaP_end": [self.method_textonpath, "100%", "end", None, None],
            "default_area": [self.method_fixedtext, None, None, "start", 0.0],
            "FT_start": [self.method_fixedtext, None, None, "start", 0.0],
            "FT_bbox": [self.method_fixedtext, None, None, "center", 0.0],
            "FT_mass": [self.method_fixedtext, None, None, "mass", 0.0],
        }

        if self.options.presetFormat == "default":
            current_preset = "default_" + self.options.mtype
        else:
            current_preset = self.options.presetFormat

        self.options.startOffset = preset_dict[current_preset][1]
        self.options.anchor = preset_dict[current_preset][2]
        self.options.position = preset_dict[current_preset][3]
        self.options.angle = preset_dict[current_preset][4]
        method = preset_dict[current_preset][0]
        if method is not None:
            return method(node, lenstr)

    def add_cross(self, node, x, y, scale):
        l = 3 * scale  # 3 pixels in document units
        node.set(
            "d",
            "m %s,%s %s,0 %s,0 m %s,%s 0,%s 0,%s"
            % (str(x - l), str(y), str(l), str(l), str(-l), str(-l), str(l), str(l)),
        )
        node.set("style", "stroke:#000000;fill:none;stroke-width:%s" % str(0.5 * scale))

    def add_textonpath(self, node, x, y, text, _node, anchor, startOffset, dy=0):
        new = node.add(TextPath())
        s = {
            "text-align": "center",
            "vertical-align": "bottom",
            "text-anchor": anchor,
            "font-size": str(self.options.fontsize),
            "fill-opacity": "1.0",
            "stroke": "none",
            "font-weight": "normal",
            "font-style": "normal",
            "fill": "#000000",
        }
        new.style = s
        new.href = _node
        new.set("startOffset", startOffset)
        new.set("dy", str(dy))  # dubious merit
        # new.append(tp)
        if text[-2:] == "^2":
            new.append(Tspan.superscript("2"))
            new.text = str(text)[:-2]
        else:
            new.text = str(text)
        # node.set('transform','rotate(180,'+str(-x)+','+str(-y)+')')
        node.set("x", str(x))
        node.set("y", str(y))

    def add_fixedtext(self, node, x, y, text, anchor, angle, dy=0):
        new = node.add(Tspan())
        new.set("sodipodi:role", "line")
        s = {
            "text-align": "center",
            "vertical-align": "bottom",
            "text-anchor": anchor,
            "font-size": self.svg.viewport_to_unit(self.options.fontsize),
            "fill-opacity": "1.0",
            "stroke": "none",
            "font-weight": "normal",
            "font-style": "normal",
            "fill": "#000000",
        }
        new.style = s
        new.set("dy", str(dy))
        if text[-2:] == "^2":
            new.append(Tspan.superscript("2"))
            new.text = str(text)[:-2]
        else:
            new.text = str(text)
        node.set("x", str(x))
        node.set("y", str(y))
        node.set("transform", "rotate(%s, %s, %s)" % (angle, x, y))
        node.transform = -node.getparent().composed_transform() @ node.transform


if __name__ == "__main__":
    MeasureLength().run()
