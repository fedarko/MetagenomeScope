"use strict";

/* Copyright (C) 2017 Marcus Fedarko, Jay Ghurye, Todd Treangen, Mihai Pop
 * Authored by Marcus Fedarko
 *
 * This file is part of MetagenomeScope.
 * 
 * MetagenomeScope is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * MetagenomeScope is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with MetagenomeScope.  If not, see <http://www.gnu.org/licenses/>.
 ****
 * This script uses Cytoscape.js and sql.js to provide functionality to the
 * viewer interface web application.
 */

// How many bytes to read at once from a .agp file
// For now, we set this to 1 MiB. The maximum Blob size in most browsers is
// around 500 - 600 MiB, so this should be well within that range.
// (We want to strike a balance between a small Blob size -- which causes lots
// of reading operations to be done, which takes a lot of time -- and a huge
// Blob size, which can potentially run out of memory, causing the read
// operation to fail.)
var BLOB_SIZE = 1048576;

// Various coordinates that are used to define polygon node shapes in
// Cytoscape.js (see their documentation for the format specs of these
// coordinates).
// The suffix indicates the directionality for which the polygon should be
// used. LEFTRIGHT means that the polygon should be used for either the default
// direction (LEFT, ->) or its opposite (RIGHT, <-); UPDOWN has similar
// meaning.
var FRAYED_ROPE_LEFTRIGHTDIR = "-1 -1 0 -0.5 1 -1 1 1 0 0.5 -1 1";
var FRAYED_ROPE_UPDOWNDIR =    "1 -1 0.5 0 1 1 -1 1 -0.5 0 -1 -1";
var BUBBLE_LEFTRIGHTDIR =      "-1 0 -0.5 -1 0.5 -1 1 0 0.5 1 -0.5 1";
var BUBBLE_UPDOWNDIR =         "-1 -0.5 0 -1 1 -0.5 1 0.5 0 1 -1 0.5";
var NODE_LEFTDIR =             "1 1 -0.23587 1 -1 0 -0.23587 -1 1 -1";
var NODE_RIGHTDIR =            "-1 1 0.23587 1 1 0 0.23587 -1 -1 -1";
var NODE_UPDIR =               "-1 1 -1 -0.23587 0 -1 1 -0.23587 1 1";
var NODE_DOWNDIR =             "-1 -1 -1 0.23587 0 1 1 0.23587 1 -1";
var SQUARE_COORDS =            "-1 -1 -1 1 1 1 1 -1";

// Approximate conversion factor from inches (the unit used by GraphViz for
// node width/height measurements) to pixels. TODO, we might want to
// consider node size more closely to see how accurate we can get it?
// Also -- maybe multiply coordinates by this, to get things worked out?
// 72 ppi?
var INCHES_TO_PIXELS = 54;

// Anything less than this constant will be considered a "straight" control
// point distance. This way we can approximate simple B-splines with straight
// bezier curves (which are cheaper and easier to draw).
var CTRL_PT_DIST_EPSILON = 1.00;
// Edge thickness stuff, as will be rendered by Cytoscape.js
// Used in tandem with the "thickness" percentage associated with each edge in
// the input .db file to scale edges' displayed "weight" accordingly
var MAX_EDGE_THICKNESS = 10;
var MIN_EDGE_THICKNESS = 3;
// We just calculate this here to save on the costs of calculating it |edges|
// times during drawing:
var EDGE_THICKNESS_RANGE = MAX_EDGE_THICKNESS - MIN_EDGE_THICKNESS;

// Misc. global variables we use to get certain functionality
// The current "view type" -- will always be one of {"SPQR", "double"}
var CURR_VIEWTYPE;
// The current "SPQR mode" -- will always be one of {"implicit", explicit"}
var CURR_SPQRMODE;
// mapping of {bicomponent ID => an array of the IDs of the visible singlenodes
// in that bicomponent}
var BICOMPONENTID2VISIBLESINGLENODEIDS = {};
// The bounding box of the graph
var CURR_BOUNDINGBOX;
// In degrees CCW from the default up->down direction
var PREV_ROTATION;
var CURR_ROTATION;
// The current colorization "value" -- used to prevent redundant applications
// of changing colorization.
var CURR_NODE_COLORIZATION = null;
// Objects containing the RGB data for the maximum/minimum color in
// colorization schemes, respectively. We precompute these values and store
// them in these variables in initGraph(). This avoids making 2|V| calls to
// .toRGB() (i.e. getting these values in getNodeColorization()) when just 2
// calls would suffice.
var MAX_RGB = undefined;
var MIN_RGB = undefined;
// The hex string colors for MAX_RGB and MIN_RGB.
var MAX_HEX = undefined;
var MIN_HEX = undefined;
// The default node color in the current colorization settings. Used when
// colorizing nodes that have no repeat data (but other nodes do have repeat
// data).
var DEFAULT_NODE_COLOR = undefined;
// The default colorization settings.
// Used for the "reset color settings to defaults" button.
// NOTE -- If the default color settings are updated, this can also be updated
// relatively easily by just loading the viewer interface, exporting the
// default settings manually, and then modifying the resulting file to replace
// newlines and tabs with their repsective control character representations
// (this can be done via the commands :%s/\n/\\n/g and :%s/\t/\\t/g in Vim).
// Ideally this process would be automated, but there have been some issues
// with that (see issue #263 on GitHub for a bit of a summary).
var DEFAULT_COLOR_SETTINGS = "mincncp\t#0022ff\nmaxcncp\t#ff2200\ncnlcp\t#ffffff\ncsnlcp\t#ffffff\nusncp\t#888888\nbubblecp\t#9abaf3\nfropecp\t#59f459\nchaincp\t#fcaca3\nychaincp\t#ffd163\nspqrscp\t#ffd644\nspqrpcp\t#eb8ef9\nspqrrcp\t#31bf6f\nbicmpcp\t#e9e9e9\ntnbcp\t#000000\ntngbcp\t#000000\nusnlcp\t#ffffff\nsnlcp\t#ffffff\nusecp\t#555555\nsecp\t#111111\nhoecp\t#ff0000\nhosecp\t#800000\nloecp\t#0000ff\nlosecp\t#000080\ncngcccp\t#000000\nsngbcp\t#000000\nbgcp\t#ffffff\n";
// The background color of the graph. Set in initGraph().
var BG_COLOR = undefined;
// Booleans for whether or not to use certain performance options
var HIDE_EDGES_ON_VIEWPORT = false;
var TEXTURE_ON_VIEWPORT = false;
// Array of edge weights in current connected component. Used when drawing a
// histogram of edge weights.
var COMPONENT_EDGE_WEIGHTS = [];
// A reference to the current SQL.Database object from which we obtain the
// graph's layout and biological data
var CURR_DB = null;
// Filetype of the assembly; used for determining bp vs. nt for nodes
var ASM_FILETYPE;
// Whether or not actual DNA sequences were provided to the preprocessing
// script (impacts the availability of GC content display and colorization)
var DNA_AVAILABLE;
// Whether or not repeat data was provided in the input to the preprocessing
// script (impacts the availability of repeat colorization)
var REPEAT_INFO_AVAILABLE;
// FIlename of the currently loaded .db file
var DB_FILENAME;
// Total number of nodes and edges in the current asm graph
var ASM_NODE_COUNT = 0;
var ASM_EDGE_COUNT = 0;
var CURR_NE = 0;
// How often (e.g. after how many nodes/half-edges) we update the progress
// bar with its new value. Will be set in drawComponent() for the current
// component being drawn, taking into account PROGRESSBAR_FREQ_PERCENT.
// Higher values of this mean less timeouts are used to update the
// progress bar, which means the graph is loaded somewhat faster,
// while smaller values of this mean more timeouts are used (i.e.
// slower graph loading) but choppier progress bar progress occurs.
var PROGRESSBAR_FREQ;
// PROGRESSBAR_FREQ = Math.floor(PROGRESSBAR_FREQ_PERCENT * SIZE), where
// SIZE = (number of nodes to be drawn) + 0.5*(number of edges to be drawn)
var PROGRESSBAR_FREQ_PERCENT = 0.05;

// Cytoscape.js graph instance
var cy = null;
// Numbers of selected elements, and collections of those selected elements.
var SELECTED_NODE_COUNT = 0;
var SELECTED_EDGE_COUNT = 0;
var SELECTED_CLUSTER_COUNT = 0;
var SELECTED_NODES = null;
var SELECTED_EDGES = null;
var SELECTED_CLUSTERS = null;
// Collection of removed edges (due to a minimum bundle size threshold).
var REMOVED_EDGES = null;
var PREV_EDGE_WEIGHT_THRESHOLD = null;
// Mapping of scaffold ID to labels or IDs (should depend on the assembly
// filetype, but really can refer to anything in COMPONENT_NODE_KEYS) of the
// nodes contained within the scaffold, as an array.
// Used when highlighting nodes contained within a scaffold.
var SCAFFOLDID2NODEKEYS = {};
// Array of scaffolds in the current connected component, in the order they
// were listed in the input AGP file. Used when cycling through scaffolds.
var COMPONENT_SCAFFOLDS = [];
// Current index of the drawScaffoldButton in COMPONENT_SCAFFOLDS. Used when
// cycling through scaffolds.
var SCAFFOLD_CYCLER_CURR_INDEX = 0;
// Used to indicate whether or not the current component has scaffolds added
// from the AGP file -- this, in turn, is used to determine what text to
// display to the user in the "View Scaffolds" area.
var COMPONENT_HAS_SCAFFOLDS = false;
// "Keys" referring to nodes in the currently-drawn connected component.
// Used in determining which scaffolds are in the current connected component.
var COMPONENT_NODE_KEYS = [];
// Flag indicating whether or not the application is in "finishing mode," in
// which the user can select nodes to manually construct a path through the
// assembly.
var FINISHING_MODE_ON = false;
// Flag indicating whether or not a previous finishing process was performed.
var FINISHING_MODE_PREVIOUSLY_DONE = false;
// String of the node IDs (in order -- the first node ID is the first ID in the
// reconstructed sequence, and so on) that are part of the constructed path.
// In the format "N1,N2,N3,N4" where N1 is the first node ID, N2 is the second
// node ID, and so on (allowing repeat duplicate IDs).
var FINISHING_NODE_IDS = "";
// Like FINISHING_NODE_IDS, but each element in this list is the actual
// Cytoscape.js object for the corresponding node in the path
var FINISHING_NODE_OBJS = [];
// Nodes that are outgoing from the last-added node to the reconstructed path.
var NEXT_NODES;
// Boolean used to indicate when finishing a linear cycle is happening.
var FINISHING_LINEAR_CYCLE;

// HTML snippets used while auto-creating info tables about selected elements
var TD_CLOSE = "</td>";
var TD_START = "<td>";
// Regular expression we use when matching integers.
var INTEGER_RE = /^\d+$/;

var startDrawDate, endDrawDate;

if (!(window.File && window.FileReader)) {
	alert("Your browser does not support the HTML5 File APIs. " +
          "You will not be able to upload any .db files, although " +
          "you can still try out any available demo .db files.");
}

// Initializes the Cytoscape.js graph instance.
// Takes as argument the "view type" of the graph to be drawn (see top of file
// defn. of CURR_VIEWTYPE for details).
function initGraph(viewType) {
    CURR_VIEWTYPE = viewType;
    // MAX_RGB and MIN_RGB will only be computed if they haven't been set
    // already (i.e. if the user hasn't changed the default colors and hasn't
    // drawn any connected components yet).
    // We take this approach (instead of just giving MAX_RGB and MIN_RGB their
    // default values here) in order to reduce redundancy, to thus make
    // changing the default values easier in the future (only have to change
    // the HTML, instead of both HTML and JS).
    var tmpColor;
    if (MAX_RGB === undefined) {
        tmpColor = $("#maxcncp").data("colorpicker").color;
        MAX_RGB = tmpColor.toRGB();
        MAX_HEX = tmpColor.toHex();
    }
    if (MIN_RGB === undefined) {
        tmpColor = $("#mincncp").data("colorpicker").color;
        MIN_RGB = tmpColor.toRGB();
        MIN_HEX = tmpColor.toHex();
    }
    BG_COLOR = $("#bgcp").colorpicker("getValue");
    DEFAULT_NODE_COLOR = $("#usncp").colorpicker("getValue");
    $("#cy").css("background", BG_COLOR);
    cy = cytoscape({
        container: document.getElementById("cy"),
        layout: {
            // We parse GraphViz' generated xdot files to copy the layout
            // provided by GraphViz. To manually specify node positions, we
            // use the "preset" Cytoscape.js layout.
            name: 'preset'
        },
        // We set minZoom based on the zoom level obtained by cy.fit().
        // maxZoom, however, is defined based on the zoom level of zooming to
        // fit around a single node -- which usually has an upper bound of 9 or
        // so, based on some tests. (Hence why we just set maxZoom here.)
        maxZoom: 9,
        // (sometimes slight) performance improvements
        pixelRatio: 1.0,
        hideEdgesOnViewport: HIDE_EDGES_ON_VIEWPORT,
        textureOnViewport: TEXTURE_ON_VIEWPORT,
        // options we use to prevent user from messing with the graph before
        // it's been fully drawn
        userPanningEnabled: false,
        userZoomingEnabled: false,
        boxSelectionEnabled: false,
        autounselectify: true,
        autoungrabify: true,
        style: [
            {
                selector: 'node',
                style: {
                    width: 'data(w)',
                    height: 'data(h)'
                }
            },
            // The following few classes are used to set properties of
            // compound nodes (analogous to clusters in GraphViz) 
            {
                selector: 'node.cluster',
                style: {
                    'shape': 'rectangle',
                    'border-width': 0
                }
            },
            {
                selector: 'node.cluster.spqrMetanode',
                style: {
                    'background-opacity': 0.65
                }
            },
            {
                selector: 'node.cluster.structuralPattern',
                style: {
                    'padding-top': 0,
                    'padding-right': 0,
                    'padding-left': 0,
                    'padding-bottom': 0
                }
            },
            {
                // Give collapsed variants a number indicating child count
                selector: 'node.cluster.structuralPattern[?isCollapsed]',
                style: {
                    'min-zoomed-font-size': 12,
                    'font-size': 48,
                    'label': 'data(interiorNodeCount)',
                    'text-valign': 'center',
                    'font-weight': 'bold',
                    'color': $("#cngcccp").colorpicker("getValue")
                }
            },
            {
                selector: 'node.F',
                style: {
                    // default color matches 'green2' in graphviz
                    // (but honestly I just picked what I considered to be
                    // the least visually offensive shade of green)
                    'background-color': $("#fropecp").colorpicker("getValue"),
                    shape: 'polygon'
                }
            },
            {
                selector: 'node.B',
                style: {
                    // default color matches 'cornflowerblue' in graphviz
                    'background-color': $("#bubblecp").colorpicker("getValue"),
                    shape: 'polygon'
                }
            },
            {
                selector: 'node.B.leftrightdir',
                style: {
                    'shape-polygon-points': BUBBLE_LEFTRIGHTDIR
                }
            },
            {
                selector: 'node.B.updowndir',
                style: {
                    'shape-polygon-points': BUBBLE_UPDOWNDIR
                }
            },
            {
                selector: 'node.F.leftrightdir',
                style: {
                    'shape-polygon-points': FRAYED_ROPE_LEFTRIGHTDIR
                }
            },
            {
                selector: 'node.F.updowndir',
                style: {
                    'shape-polygon-points': FRAYED_ROPE_UPDOWNDIR
                }
            },
            {
                selector: 'node.C',
                style: {
                    // default color matches 'salmon' in graphviz
                    'background-color': $("#chaincp").colorpicker("getValue")
                }
            },
            {
                selector: 'node.Y',
                style: {
                    // default color matches 'darkgoldenrod1' in graphviz
                    'background-color': $("#ychaincp").colorpicker("getValue"),
                    'shape': 'ellipse'
                }
            },
            {
                selector: 'node.cluster.pseudoparent',
                style: {
                    'z-index-compare': 'manual',
                    'z-index': 0
                }
            },
            {
                selector: 'node.I',
                style: {
                    'background-color': $("#bicmpcp").colorpicker("getValue")
                }
            },
            {
                selector: 'node.S',
                style: {
                    'background-color': $("#spqrscp").colorpicker("getValue")
                }
            },
            {
                selector: 'node.P',
                style: {
                    'background-color': $("#spqrpcp").colorpicker("getValue")
                }
            },
            {
                selector: 'node.R',
                style: {
                    'background-color': $("#spqrrcp").colorpicker("getValue")
                }
            },
            {
                selector: 'node.bb_enforcing',
                style: {
                    // Make these nodes invisible
                    'background-opacity': 0,
                    // A width/height of zero just results in Cytoscape.js not
                    // drawing these nodes -- hence a width/height of one
                    width: 1,
                    height: 1
                }
            },
            {
                selector: 'node.noncluster',
                style: {
                    label: 'data(label)',
                    'text-valign': 'center',
                    // rendering text is computationally expensive, so if
                    // we're zoomed out so much that the text would be
                    // illegible (or hard-to-read, at least) then don't
                    // render the text.
                    'min-zoomed-font-size': 12,
                    'z-index': 2,
                    'z-index-compare': 'manual'
                }
            },
            {
                // Used for individual nodes in a SPQR-integrated view
                // (these nodes lack orientation, so they're drawn as just
                // rectangles)
                selector: 'node.noncluster.singlenode',
                style: {
                    shape: 'rectangle'
                }
            },
            {
                selector: 'node.noncluster.noncolorized',
                style: {
                    'background-color': DEFAULT_NODE_COLOR,
                    'color': $("#usnlcp").colorpicker("getValue")
                }
            },
            {
                selector: 'node.noncluster.gccolorized',
                style: {
                    'background-color': 'data(gc_color)',
                    'color': $("#cnlcp").colorpicker("getValue")
                }
            },
            {
                selector: 'node.noncluster.repeatcolorized',
                style: {
                    'background-color': 'data(repeat_color)',
                    'color': $("#cnlcp").colorpicker("getValue")
                }
            },
            {
                selector: 'node.noncluster.updir',
                style: {
                    'shape-polygon-points': NODE_UPDIR,
                    shape: 'polygon'
                }
            },
            {
                selector: 'node.noncluster.downdir',
                style: {
                    'shape-polygon-points': NODE_DOWNDIR,
                    shape: 'polygon'
                }
            },
            {
                selector: 'node.noncluster.leftdir',
                style: {
                    'shape-polygon-points': NODE_LEFTDIR,
                    shape: 'polygon'
                }
            },
            {
                selector: 'node.noncluster.rightdir',
                style: {
                    'shape-polygon-points': NODE_RIGHTDIR,
                    shape: 'polygon'
                }
            },
            {
                selector: 'node.noncluster.tentative',
                style: {
                    'border-width': 5,
                    'border-color': $("#tnbcp").colorpicker("getValue")
                }
            },
            {
                selector: 'node.cluster.tentative',
                style: {
                    'border-width': 5,
                    'border-color': $("#tngbcp").colorpicker("getValue")
                }
            },
            {
                selector: 'node.noncluster.tentativedock',
                style: {
                    'background-color': '#994700',
                }
            },
            {
                selector: 'node.noncluster:selected',
                style: {
                    // NOTE I liked using a border for indicating selected
                    // nodes, but it interfered with unbundled-bezier edges
                    // occasionally. So we just darken selected nodes instead.
                    //'border-color': '#000',
                    //'border-opacity': 1,
                    //'border-width': 5
                    'background-blacken': 0.5
                }
            },
            {
                selector: 'node.noncluster.noncolorized:selected',
                style: {
                    'color': $("#snlcp").colorpicker("getValue")
                }
            },
            {
                selector: 'node.noncluster.gccolorized:selected',
                style: {
                    'color': $("#csnlcp").colorpicker("getValue")
                }
            },
            {
                selector: 'node.cluster:selected',
                style: {
                    'border-width': 5,
                    'border-color': $("#sngbcp").colorpicker("getValue")
                }
            },
            {
                selector: 'edge',
                style: {
                    'width': 'data(thickness)',
                    'line-color': $("#usecp").colorpicker("getValue"),
                    'target-arrow-color': $("#usecp").colorpicker("getValue"),
                    'loop-direction': '30deg',
                    'z-index': 3,
                    'z-index-compare': 'manual'
                }
            },
            {
                selector: 'edge:selected',
                style: {
                    'line-color': $("#secp").colorpicker("getValue"),
                    'target-arrow-color': $("#secp").colorpicker("getValue")
                }
            },
            {
                selector: 'edge.oriented',
                style: {
                    'target-arrow-shape': 'triangle',
                    'target-endpoint': '-50% 0%',
                    'source-endpoint': '50% 0'
                }
            },
            {
                selector: 'edge.unoriented_loop',
                style: {
                    'target-endpoint': '-50% 0%',
                    'source-endpoint': '50% 0'
                }
            },
            {
                // Used for edges that were assigned valid (i.e. not
                // just a straight line or self-directed edge)
                // cpd/cpw properties from the xdot file.
                selector: 'edge.unbundledbezier',
                style: {
                    'curve-style': 'unbundled-bezier',
                    'control-point-distances': 'data(cpd)',
                    'control-point-weights': 'data(cpw)',
                    'edge-distances': 'node-position'
                }
            },
            {
                // Used for:
                //  -Self-directed edges
                //  -Lines that are determined upon parsing the xdot file to
                //   be sufficiently close to a straight line
                //  -Temporary edges, for which we have no control point
                //   data (i.e. any edges directly from/to compound nodes
                //   during the collapsing process)
                selector: 'edge.basicbezier',
                style: {
                    'curve-style': 'bezier'
                }
            },
            {
                selector: 'edge.virtual',
                style: {
                    'line-style': 'dashed'
                }
            },
            {
                selector: 'edge.high_outlier',
                style: {
                    'line-color': $("#hoecp").colorpicker("getValue"),
                    'target-arrow-color': $("#hoecp").colorpicker("getValue")
                }
            },
            {
                selector: 'edge.high_outlier:selected',
                style: {
                    'line-color': $("#hosecp").colorpicker("getValue"),
                    'target-arrow-color': $("#hosecp").colorpicker("getValue")
                }
            },
            {
                selector: 'edge.low_outlier',
                style: {
                    'line-color': $("#loecp").colorpicker("getValue"),
                    'target-arrow-color': $("#loecp").colorpicker("getValue")
                }
            },
            {
                selector: 'edge.low_outlier:selected',
                style: {
                    'line-color': $("#losecp").colorpicker("getValue"),
                    'target-arrow-color': $("#losecp").colorpicker("getValue")
                }
            },
            {
                // Used to differentiate edges without an overlap between nodes
                // in graphs where overlap data is given
                // this conflicts with virtual edges' style, so we may want to
                // change this in the future
                // (using "dotted" lines was really slow)
                selector: 'edge.nooverlap',
                style: {
                    'line-style': 'dashed'
                }
            }
        ]
    });
}

/* Given a cluster, either collapses it (if already uncollapsed) or
 * uncollapses it (if already collapsed).
 */
function toggleCluster(cluster) {
    cy.startBatch();
    if (cluster.data("isCollapsed")) {
        uncollapseCluster(cluster);
    }
    else {
        collapseCluster(cluster);
    }
    cy.endBatch();
}

/* Collapses a given single cluster, making use of the
 * cluster's actual and canonical exterior edge data.
 * 
 * NOTE that this can result in the presence of codirected edges, if a
 * single node connects to multiple edges within the cluster (e.g. a
 * node has two outgoing edges, to both starting nodes of a frayed rope).
 */
function collapseCluster(cluster, moveMap) {
    var children = cluster.children();
    // Prevent this cluster from being collapsed if any of its children are
    // tentative nodes in finishing mode
    if (FINISHING_MODE_ON) {
        for (var ci = 0; ci < children.length; ci++) {
            if (children[ci].hasClass("tentative")) {
                return;
            }
        }
    }
    // For each edge with a target in the compound node...
    for (var incomingEdgeID in cluster.data("incomingEdgeMap")) {
        var oldEdge = cy.getElementById(incomingEdgeID);
        oldEdge.removeClass("unbundledbezier");
        oldEdge.addClass("basicbezier");
        oldEdge.move({target: cluster.id()});
    }
    // For each edge with a source in the compound node...
    for (var outgoingEdgeID in cluster.data("outgoingEdgeMap")) {
        var oldEdge = cy.getElementById(outgoingEdgeID);
        oldEdge.removeClass("unbundledbezier");
        oldEdge.addClass("basicbezier");
        oldEdge.move({source: cluster.id()});
    }
    cluster.data("isCollapsed", true);
    // Update list of locally collapsed nodes (useful for global toggling)
    cy.scratch("_collapsed", cy.scratch("_collapsed").union(cluster));
    cy.scratch("_uncollapsed", cy.scratch("_uncollapsed").difference(cluster));
    if (cy.scratch("_uncollapsed").empty()) {
        if ($("#collapseButtonText").text()[0] === 'C') {
            changeCollapseButton(true);
        }
    }
    // Unselect the elements before removing them (fixes #158 on GitHub)
    cluster.scratch("_interiorEles").unselect();
    // "Remove" the elements (they can be added back to the graph upon
    // uncollapsing this cluster, of course)
    cluster.scratch("_interiorEles").remove();
}

/* Uncollapses a given single cluster, making use of the cluster's actual
 * and canonical exterior edge data.
 */
function uncollapseCluster(cluster) {
    // Prevent this cluster from being uncollapsed if it's a "tentative" node
    // in finishing mode
    if (FINISHING_MODE_ON) {
        if (cluster.hasClass("tentative")) {
            return;
        }
    }
    // Restore child nodes + interior edges
    cluster.scratch("_interiorEles").restore();
    // "Reset" edges to their original target/source within the cluster
    for (var incomingEdgeID in cluster.data("incomingEdgeMap")) {
        if (REMOVED_EDGES.is("[id=\"" + incomingEdgeID + "\"]")) {
            // The edge has probably been removed from the graph due to 
            // the edge weight thing -- ignore it
            continue;
        }
        var newTgt = cluster.data("incomingEdgeMap")[incomingEdgeID][1];
        var oldEdge = cy.getElementById(incomingEdgeID);
        // If the edge isn't connected to another cluster, and the edge
        // wasn't a basicbezier to start off with (i.e. it has control point
        // data), then change its classes to update its style.
        if (!oldEdge.source().hasClass("cluster") && oldEdge.data("cpd")) {
            if (!oldEdge.hasClass("reducededge")) {
                oldEdge.removeClass("basicbezier");
                oldEdge.addClass("unbundledbezier");
            }
        }
        oldEdge.move({target: newTgt});
    }
    for (var outgoingEdgeID in cluster.data("outgoingEdgeMap")) {
        if (REMOVED_EDGES.is("[id=\"" + outgoingEdgeID + "\"]")) {
            continue;
        }
        var newSrc = cluster.data("outgoingEdgeMap")[outgoingEdgeID][0];
        var oldEdge = cy.getElementById(outgoingEdgeID);
        if (!oldEdge.target().hasClass("cluster") && oldEdge.data("cpd")) {
            if (!oldEdge.hasClass("reducededge")) {
                oldEdge.removeClass("basicbezier");
                oldEdge.addClass("unbundledbezier");
            }
        }
        oldEdge.move({source: newSrc});
    }
    // Update local flag for collapsed status (useful for local toggling)
    cluster.data("isCollapsed", false);
    // Update list of locally collapsed nodes (useful for global toggling)
    cy.scratch("_collapsed", cy.scratch("_collapsed").difference(cluster));
    cy.scratch("_uncollapsed", cy.scratch("_uncollapsed").union(cluster));
    if (cy.scratch("_collapsed").empty()) {
        if ($("#collapseButtonText").text()[0] === 'U') {
            changeCollapseButton(false);
        }
    }
}

function addSelectedNodeInfo(ele) {
    var lengthEntry = ele.data("length").toLocaleString();
    if (ASM_FILETYPE === "GML" || CURR_VIEWTYPE === "SPQR") {
        // These are oriented contigs (in a GML file), or they're directionless
        // contigs (in the undirected SPQR view).
        lengthEntry += " bp";
    } else {
        // These are unoriented contigs; each contig represents a piece of DNA,
        // but since the contigs are unoriented we don't know which strand of
        // DNA the contigs arise from. Therefore we represent them as two
        // separate contigs, referred to as +/-.
        lengthEntry += " nt";
    }
    var eleID = ele.id();
    var nodeRowHTML = "<tr class='nonheader' id='row" + eleID + "'><td>";
    // Add node ID here. If we're in the SPQR viewing mode, nodes' IDs are
    // unambiguous, but contain extra info (they're suffixed by the name of
    // their parent metanode, if present). However, there's not really a need
    // to show the user this information, so we truncate the displayed IDs
    // accordingly. (Otherwise, we just show the user the entire node ID.)
    if (CURR_VIEWTYPE === "SPQR") {
        nodeRowHTML += eleID.split("_")[0];
    }
    else {
        nodeRowHTML += eleID;
    }
    nodeRowHTML += TD_CLOSE;
    if (ASM_FILETYPE === "GML") {
        nodeRowHTML += TD_START + ele.data("label") + TD_CLOSE;
    }
    nodeRowHTML += TD_START + lengthEntry + TD_CLOSE;
    if (ASM_FILETYPE === "LastGraph") {
        // Round to two decimal places
        var depthEntry = Math.round(ele.data("depth") * 100) / 100 + "x";
        nodeRowHTML += TD_START + depthEntry + TD_CLOSE;
    }
    if (DNA_AVAILABLE) {
        // Round to two decimal places
        // we multiply by 10000 because we're really multiplying by 100
        // twice: first to convert to a percentage, then to start the
        // rounding process
        var gcEntry = Math.round(ele.data("gc_content") * 10000) / 100 + "%";
        nodeRowHTML += TD_START + gcEntry + TD_CLOSE;
    }
    if (REPEAT_INFO_AVAILABLE) {
        var is_repeat = ele.data("is_repeat");
        var repeatEntry;
        if (is_repeat === 1) {
            repeatEntry = "True";
        } else if (is_repeat === 0) {
            repeatEntry = "False";
        } else {
            repeatEntry = "N/A";
        }
        nodeRowHTML += TD_START + repeatEntry + TD_CLOSE;
    }
    nodeRowHTML += "</tr>";
    $("#nodeInfoTable").append(nodeRowHTML);
}

function addSelectedEdgeInfo(ele) {
    // returns an array of two elements: [source node id, target node id]
    var displaySourceID, displayTargetID;
    if (CURR_VIEWTYPE === "SPQR" && ele.data("dispsrc") !== undefined) {
        displaySourceID = ele.data("dispsrc");
        displayTargetID = ele.data("disptgt");
    }
    else {
        //var canonicalSourceAndTargetNode = ele.id().split("->");
        //displaySourceID = canonicalSourceAndTargetNode[0];
        //displayTargetID = canonicalSourceAndTargetNode[1];
        displaySourceID = ele.source().id();
        displayTargetID = ele.target().id();
    }
    var edgeRowHTML = "<tr class='nonheader' id='row" +
        ele.id().replace(">", "") + "'><td>" +
        displaySourceID + "</td><td>" + displayTargetID + TD_CLOSE;
    if (ASM_FILETYPE === "GML" || ASM_FILETYPE === "LastGraph")
        edgeRowHTML += TD_START;
        if (CURR_VIEWTYPE !== "SPQR") {
            edgeRowHTML += ele.data("multiplicity");
        }
        else {
            edgeRowHTML += "N/A";
        }
        edgeRowHTML += TD_CLOSE;
    if (ASM_FILETYPE === "GML") {
        if (CURR_VIEWTYPE === "SPQR") {
            edgeRowHTML += "<td>N/A</td>N/A<td>N/A</td>N/A<td>N/A</td>";
        }
        else {
            // Round mean and stdev entries both to two decimal places
            // These values are just estimates so this rounding is okay
            var meanEntry = Math.round(ele.data("mean") * 100) / 100;
            var stdevEntry = Math.round(ele.data("stdev") * 100) / 100;
            edgeRowHTML += TD_START + ele.data("orientation") + TD_CLOSE;
            edgeRowHTML += TD_START + meanEntry + TD_CLOSE;
            edgeRowHTML += TD_START + stdevEntry + TD_CLOSE;
        }
    }
    edgeRowHTML += "</tr>";
    $("#edgeInfoTable").append(edgeRowHTML);
}

function addSelectedClusterInfo(ele) {
    var clustID = ele.data("id");
    var clustType;
    switch(clustID[0]) {
        case 'C': clustType = "Chain"; break;
        case 'Y': clustType = "Cyclic Chain"; break;
        case 'B': clustType = "Bubble"; break;
        case 'F': clustType = "Frayed Rope"; break;
        case 'I': clustType = "Bicomponent"; break;
        case 'S': clustType = "Series Metanode"; break;
        case 'P': clustType = "Parallel Metanode"; break;
        case 'R': clustType = "Rigid Metanode"; break;
        default: clustType = "Invalid (error)";
    }
    var clustSize = ele.data("interiorNodeCount");
    $("#clusterInfoTable").append("<tr class='nonheader' id='row" + ele.id() +
        "'><td>" + clustType + "</td><td>" + clustSize + "</td></tr>");
}

function removeSelectedEleInfo(ele) {
    // supports edges in old HTML versions, where > isn't allowed but - is
    $("#row" + ele.id().replace(">", "")).remove();
}

/* Sets bindings for certain DOM elements on the page.
 * To be called when the DOM is ready to be manipulated.
 */
function doThingsWhenDOMReady() {
    // Ensure that all colorpickers (the pop-up things where
    // you can select a color with the mouse) get closed when
    // the settings dialog is closed.
    $("#settingsDialog").on("hide.bs.modal", function(e) {
        $(".colorpicker-component").colorpicker("hide");
    });
    // Initialize colorpickers
    $(".colorpicker-component").colorpicker({format: 'hex'});
    $("#mincncp").on("changeColor", function(e) {
        redrawGradientPreview(e.color.toHex(), -1);
    });
    $("#maxcncp").on("changeColor", function(e) {
        redrawGradientPreview(e.color.toHex(), 1);
    });
    // Update the gradient preview to whatever the default colorization values
    // are. Note that we have to manually set either the min or max color
    // ourselves since redrawGradientPreview only handles one change at a time.
    $("#100gp").css("background-color", $("#maxcncp").colorpicker("getValue"));
    redrawGradientPreview($("#mincncp").colorpicker("getValue"), -1);
    // If we add any tooltips, use this line to initialize them
    //$("[data-toggle='tooltip']").tooltip();
}

// Things that are bound to the "beforeunload" event on the window.
function doThingsBeforeUnload() {
    closeDB();
}

// Sets bindings for certain objects in the graph.
function setGraphBindings() {
    // Enable right-clicking to collapse/uncollapse compound nodes
    // We store added edges + removed nodes/edges in element-level
    // data, to facilitate only doing the work of determining which
    // elements to remove/etc. once (the first time around)
    cy.on('cxttap', 'node.cluster.structuralPattern',
        function(e) {
            // Prevent collapsing being done during iterative drawing
            // NOTE: In retrospect, I think that thanks to the use of
            // autoungrabify/autounselectify while drawing the graph that
            // this is arguably not needed, but there isn't really any harm
            // in keeping it around for the time being
            if (!$("#fitButton").hasClass("disabled")) {
                toggleCluster(e.target);
            }
        }
    );

    // Enable SPQR tree expansion/compression
    // User can click on an uncollapsed metanode to reveal its immediate
    // children
    // User can click on a collapsed metanode to remove its immediate children
    cy.on('cxttap', 'node.cluster.spqrMetanode',
        function(e) {
            if (!$("#fitButton").hasClass("disabled")) {
                var mn = e.target;
                if (mn.data("descendantCount") > 0) {
                    if (mn.data("isCollapsed")) {
                        cy.batch(function() { uncollapseSPQRMetanode(mn); });
                    }
                    else {
                        cy.batch(function() { collapseSPQRMetanode(mn); });
                    }
                }
            }
        }
    );

    cy.on('select', 'node.noncluster, edge, node.cluster',
        function(e) {
            var x = e.target;
            if (x.hasClass("noncluster")) {
                SELECTED_NODE_COUNT += 1;
                SELECTED_NODES = SELECTED_NODES.union(x);
                $("#selectedNodeBadge").text(SELECTED_NODE_COUNT);
                addSelectedNodeInfo(x);
            } else if (x.isEdge()) {
                SELECTED_EDGE_COUNT += 1;
                SELECTED_EDGES = SELECTED_EDGES.union(x);
                $("#selectedEdgeBadge").text(SELECTED_EDGE_COUNT);
                addSelectedEdgeInfo(x);
            } else {
                SELECTED_CLUSTER_COUNT += 1;
                SELECTED_CLUSTERS = SELECTED_CLUSTERS.union(x);
                $("#selectedClusterBadge").text(SELECTED_CLUSTER_COUNT);
                addSelectedClusterInfo(x);
            }

            // If this is the first selected element, enable the
            // fitSelected button
            if (SELECTED_NODE_COUNT + SELECTED_EDGE_COUNT +
                    SELECTED_CLUSTER_COUNT === 1) {
                enableButton("fitSelectedButton");
            }
        }
    );
    cy.on('unselect', 'node.noncluster, edge, node.cluster',
        function(e) {
            var x = e.target;
            if (x.hasClass("noncluster")) {
                SELECTED_NODE_COUNT -= 1;
                SELECTED_NODES = SELECTED_NODES.difference(x);
                $("#selectedNodeBadge").text(SELECTED_NODE_COUNT);
                removeSelectedEleInfo(x);
            } else if (x.isEdge()) {
                SELECTED_EDGE_COUNT -= 1;
                SELECTED_EDGES = SELECTED_EDGES.difference(x);
                $("#selectedEdgeBadge").text(SELECTED_EDGE_COUNT);
                removeSelectedEleInfo(x);
            } else {
                SELECTED_CLUSTER_COUNT -= 1;
                SELECTED_CLUSTERS = SELECTED_CLUSTERS.difference(x);
                $("#selectedClusterBadge").text(SELECTED_CLUSTER_COUNT);
                removeSelectedEleInfo(x);
            }

            // Not sure how we'd have a negative amount of selected
            // elements, but I figure we might as well cover our bases with
            // the <= 0 here :P
            if (SELECTED_NODE_COUNT + SELECTED_EDGE_COUNT +
                    SELECTED_CLUSTER_COUNT <= 0) {
                disableButton("fitSelectedButton");
            }
        }
    );
    // TODO look into getting this more efficient in the future, if possible
    // (Renders labels only on tapping elements; doesn't really save that
    // much time, and might actually be less efficient due to the time taken
    // to register a tap event)
    //cy.on('tapstart', 'node',
    //    function(e) {
    //        var node = e.target;
    //        console.log(node);
    //        cy.style().selector("[id = '" + node.id() + "']").style({
    //            'label': 'data(id)'
    //        }).update();
    //    }
    //);
}

/* Rotates a node's position and, if applicable, its polygon definition.
 * NOTE that position of a compound node only seems to matter when that
 * compound node is collapsed -- as soon as that compound node regains
 * one or more of its children, its position is neglected again.
 */
function rotateNode(n, i) {
    // Rotate node position
    var oldPt = n.position();
    var newPt = rotateCoordinate(oldPt['x'], oldPt['y']);
    n.position({x: newPt[0], y: newPt[1]});
    // Rotate node polygon definition
    // Doing this via classes is probably more efficient than giving each
    // node its own polygon points and rotating every node's polygon points
    // every time we rotate the graph
    if (n.hasClass("noncluster")) { 
        if (n.hasClass("updir")) n.removeClass("updir");
        else if (n.hasClass("downdir")) n.removeClass("downdir");
        else if (n.hasClass("leftdir")) n.removeClass("leftdir");
        else if (n.hasClass("rightdir")) n.removeClass("rightdir");
        // NOTE removed the data(house) property so if this is reimplemented it
        // probably won't work properly without a bit of messing with it
        n.addClass(getNodeCoordClass(n.data("house")));
    }
    // We don't bother rotating cyclic chains or chains' shapes, because those
    // shapes are directionless (whereas the bubble/frayed rope shapes have
    // directionality that it looks nice to change with the graph's rotation)
    else if (n.hasClass("B") || n.hasClass("F")) {
        if (n.hasClass("updowndir")) n.removeClass("updowndir");
        else if (n.hasClass("leftrightdir")) n.removeClass("leftrightdir");
        n.addClass(getClusterCoordClass());
    }
}

/* Modifies the graph's nodes and compound nodes "in situ" to move their
 * positions, along with rotating the control points of edges and the
 * definition of the house/invhouse node polygons.
 *
 * NOTE -- DISABLED ROTATION -- this function is unused at present
 */
function changeRotation() {
    PREV_ROTATION = CURR_ROTATION;
    CURR_ROTATION = parseInt($("#rotationButtonGroup .btn.active")
        .attr("value"));
    // We use the fit button's disabled status as a way to gauge whether
    // or not a graph is currently rendered; sorta hack-ish, but it works
    if (!$("#fitButton").hasClass("disabled")) {
        startIndeterminateProgressBar();
        window.setTimeout(function() {
            cy.startBatch();
            // This only rotates nodes that are not collapsed
            cy.filter('node').each(rotateNode);
            // Rotate nodes within currently collapsed node groups
            cy.scratch("_collapsed").each(function(n, i) {
                n.scratch("_interiorNodes").each(rotateNode);
            });
            cy.endBatch();
            cy.fit();
            finishProgressBar();
        }, 20);
    }
}

// If toUncollapseReady is false, changes the collapse button to say
// "Collapse all node groups" with a minus icon.
// If toUncollapseReady is true, changes the collapse button to say
// "Uncollapse all node groups" with a plus icon.
function changeCollapseButton(toUncollapseReady) {
    if (toUncollapseReady) {
        $("#collapseButtonText").text("Uncollapse all node groups");
        $("#collapseButtonIcon").removeClass("glyphicon-minus-sign").addClass(
            "glyphicon-plus-sign");
    }
    else {
        $("#collapseButtonText").text("Collapse all node groups");
        $("#collapseButtonIcon").removeClass("glyphicon-plus-sign").addClass(
            "glyphicon-minus-sign");
    }
}

// Clears the graph, to facilitate drawing another one.
// Assumes a graph has already been drawn (i.e. cy !== null)
function destroyGraph() {
    cy.destroy();
    changeCollapseButton(false);
}

/* Loads a .db file from the user's local system. */
function loadgraphfile() {
    var fr = new FileReader();
	var inputfile = document.getElementById('fileselector').files[0];
    if (inputfile === undefined) {
        return;
    }
    if (inputfile.name.toLowerCase().endsWith(".db")) {
        DB_FILENAME = inputfile.name;
        // Important -- remove old DB from memory if it exists
        closeDB();
        disableVolatileControls();
        $("#selectedNodeBadge").text(0);
        $("#selectedEdgeBadge").text(0);
        $("#selectedClusterBadge").text(0);
        disableButton("infoButton");
        $("#currComponentInfo").html(
            "No connected component has been drawn yet.");
        fr.onload = function(e) {
            if (e.target.readyState === FileReader.DONE) {
                loadDBfile(e.target.result);
                document.getElementById('fileselector').value = "";
            }
        }
        // set progress bar to indeterminate state while we close
        // the old DB (if needed) and load the new DB file.
        // This isn't really that helpful on computers/fast-ish
        // systems, but for large DB files or mobile devices
        // (basically, anywhere sql.js might run slowly) this is
        // useful.
        // worth noting: we store this function call in an anonymous
        // function in order to delay its execution to when the
        // timeout happens
        // (javascript can be strange sometimes)
        startIndeterminateProgressBar();
        window.setTimeout(function() {
            fr.readAsArrayBuffer(inputfile);
        }, 50);
    }
    else {
        alert("Please select a valid .db file to load.");
    }
}

/* Runs prep. tasks for loading the database file and parsing its assembly +
 * component information
 */
function loadDBfile(fileData) {
    // Temporarily store .db file as array of 8-bit unsigned ints
    var uIntArr = new Uint8Array(fileData);
    CURR_DB = new SQL.Database(uIntArr);
    parseDBcomponents();
    // Set progress bar to "finished" state
    finishProgressBar();
}

/* Retrieves assembly-wide and component information from the database,
 * adjusting UI elements to prepare for component drawing accordingly.
 */
function parseDBcomponents() {
    // Get assembly-wide info from the graph
    if (cy !== null) {
        destroyGraph();
    }
    var stmt = CURR_DB.prepare("SELECT * FROM assembly;");
    stmt.step();
    var graphInfo = stmt.getAsObject();
    stmt.free();
    var fnInfo = graphInfo["filename"];
    ASM_FILETYPE = graphInfo["filetype"];
    ASM_NODE_COUNT = graphInfo["node_count"];
    var nodeInfo = ASM_NODE_COUNT.toLocaleString();
    var bpCt = graphInfo["total_length"];
    var bpInfo = bpCt.toLocaleString();
    ASM_EDGE_COUNT = graphInfo["all_edge_count"];
    var edgeCount = graphInfo["edge_count"];
    var edgeInfo = edgeCount.toLocaleString();
    var compCt = graphInfo["component_count"];
    var compInfo = compCt.toLocaleString();
    var sccCt = graphInfo["single_component_count"];
    var sccInfo = sccCt.toLocaleString();
    var bicmpCt = graphInfo["bicomponent_count"];
    var bicmpInfo = bicmpCt.toLocaleString();
    // Record N50
    var n50 = graphInfo["n50"];
    var n50Info = n50.toLocaleString();
    // Record Assembly G/C content (not available for GML files)
    var asmGC = graphInfo["gc_content"];
    DNA_AVAILABLE = (graphInfo["dna_given"] === 1) ? true : false;
    REPEAT_INFO_AVAILABLE = (graphInfo["repeats_given"] === 1) ? true : false;
    if (ASM_FILETYPE === "LastGraph" || ASM_FILETYPE === "GFA") {
        // Since the nodes in these graphs are unoriented (i.e. we draw both
        // strands of each sequence of DNA included in the assembly graph),
        // the individual nodes' units are in nucleotides (nt).
        $("#asmNodeCtTH").text("Positive Node Count");
        $("#asmEdgeCtTH").text("Positive Edge Count");
        $("#asmNodeLenTH").text("Total Positive Node Length");
        n50Info += " nt";
        bpInfo += " nt";
    } else {
        // The nodes in these graphs are oriented (i.e. each contig has a
        // specified orientation), so we just draw one node per sequence.
        // Thus, the individual nodes' units are in base pairs (bp).
        $("#asmNodeCtTH").text("Node Count");
        $("#asmEdgeCtTH").text("Edge Count");
        $("#asmNodeLenTH").text("Total Node Length");
        n50Info += " bp";
        bpInfo += " bp";
    }
    if (DNA_AVAILABLE) {
        // Round to two decimal places
        var asmGCInfo = Math.round((asmGC * 100) * 100) / 100 + "%";
        $("#asmGCEntry").text(asmGCInfo);
        $("#asmGCTH").removeClass("notviewable");
        $("#asmGCEntry").removeClass("notviewable");
    } else {
        $("#asmGCTH").addClass("notviewable");
        $("#asmGCEntry").addClass("notviewable");
    }
    // Adjust UI elements
    document.title = DB_FILENAME + " (" + fnInfo + ")";
    // TODO add back in eventually? once it plays nicely with the no drawing
    // status text stuff?
    //updateTextStatus("Loaded .db file for the assembly graph file " +fnInfo+
    //                    ".<br />You can draw a connected component using" +
    //                    " the \"Draw Connected Component\" buttons below.",
    //                    true);
    $("#filenameEntry").text(fnInfo); 
    $("#filetypeEntry").text(ASM_FILETYPE);
    $("#nodeCtEntry").text(nodeInfo); 
    $("#totalBPLengthEntry").text(bpInfo); 
    $("#edgeCountEntry").text(edgeInfo);
    $("#sccCountEntry").text(sccInfo);
    $("#bicmpCountEntry").text(bicmpInfo);
    $("#connCmpCtEntry").text(compInfo);
    $("#n50Entry").text(n50Info);
    $("#componentselector").prop("max", compCt);
    $("#componentselector").prop("disabled", false);
    enableButton("decrCompRankButton");
    enableButton("incrCompRankButton");
    enableButton("drawButton");
    $("#SPQRcomponentselector").prop("max", sccCt);
    $("#SPQRcomponentselector").prop("disabled", false);
    enableButton("decrSPQRCompRankButton");
    enableButton("incrSPQRCompRankButton");
    enableButton("drawSPQRButton");
    enableButton("implicitSPQROption");
    enableButton("explicitSPQROption");
    SCAFFOLDID2NODEKEYS = {};
    BICOMPONENTID2VISIBLESINGLENODEIDS = {};
    $("#agpLoadedFileName").addClass("notviewable");
    $("#scaffoldInfoHeader").addClass("notviewable");
    $("#scaffoldCycler").addClass("notviewable");
    COMPONENT_NODE_KEYS = [];
    $("#assembledNodes").empty();
    FINISHING_MODE_ON = false;
    FINISHING_MODE_PREVIOUSLY_DONE = false;
    FINISHING_NODE_IDS = "";
    FINISHING_NODE_OBJS = [];
    // This'll get changed to this anyway when drawing a component, but this
    // way we prevent something else from being checked in the "in-between"
    // state when no components have been drawn
    $("#noneColorization").prop("checked", true);
    enableButton("xmlFileselectButton");
    enableButton("fileselectButton");
    enableButton("loadDBbutton");
    enableButton("infoButton");
    enableButton("dir0");
    enableButton("dir90");
    enableButton("dir180");
    enableButton("dir270");
    enableButton("settingsButton");
    // Adjust selected info tables based on what info is available
    var extraNodeCols = 0;
    if (DNA_AVAILABLE) {
        $("#gcContentCol").removeClass("notviewable");
        extraNodeCols++;
    } else {
        $("#gcContentCol").addClass("notviewable");
    }
    if (REPEAT_INFO_AVAILABLE) {
        $("#repeatCol").removeClass("notviewable");
        extraNodeCols++;
    } else {
        $("#repeatCol").addClass("notviewable");
    }
    if (ASM_FILETYPE === "GML") {
        // Node info adjustments
        // All contigs in GML files have at minimum ID, label, length given
        $("#nodeTH").prop("colspan", 3 + extraNodeCols);
        $("#depthCol").addClass("notviewable");
        $("#labelCol").removeClass("notviewable");
        // Edge info adjustments
        $("#edgeTH").prop("colspan", 6);
        $("#multiplicityCol").text("B. size");
        $("#multiplicityCol").removeClass("notviewable");
        $("#orientationCol").removeClass("notviewable");
        $("#meanCol").removeClass("notviewable");
        $("#stdevCol").removeClass("notviewable");
    }
    else if (ASM_FILETYPE === "LastGraph") {
        // Node info adjustments
        // All contigs in LastGraph files have at min. ID, length, depth given
        // (they also always have GC content given, since LastGraph files seem
        // to always have sequences given, but we use extraNodeCols anyway to make
        // this more flexible)
        $("#nodeTH").prop("colspan", 3 + extraNodeCols);
        $("#depthCol").removeClass("notviewable");
        $("#labelCol").addClass("notviewable");
        // Edge info adjustments
        $("#edgeTH").prop("colspan", 3);
        $("#multiplicityCol").text("Multiplicity");
        $("#multiplicityCol").removeClass("notviewable");
        $("#orientationCol").addClass("notviewable");
        $("#meanCol").addClass("notviewable");
        $("#stdevCol").addClass("notviewable");
    }
    else if (ASM_FILETYPE === "GFA") {
        // Node info adjustments
        // All contigs in GFA files have at minimum ID, length given
        $("#nodeTH").prop("colspan", 2 + extraNodeCols);
        $("#depthCol").addClass("notviewable");
        $("#labelCol").addClass("notviewable");
        // Edge info adjustments
        $("#edgeTH").prop("colspan", 2);
        $("#multiplicityCol").addClass("notviewable");
        $("#orientationCol").addClass("notviewable");
        $("#meanCol").addClass("notviewable");
        $("#stdevCol").addClass("notviewable");
    }
}

/* Enables a disabled <button> element that is currently disabled: that is,
 * it has the disabled class (which covers Bootstrap styling) and has the
 * disabled="disabled" property.
 */
function enableButton(buttonID) {
    $("#" + buttonID).removeClass("disabled");
    $("#" + buttonID).prop("disabled", false);
}

/* Disables an enabled <button> element. */
function disableButton(buttonID) {
    $("#" + buttonID).addClass("disabled");
    $("#" + buttonID).prop("disabled", true);
}

/* Like disableButton(), but for the inline radio buttons used for node
 * colorization options. Since these don't have "disabled" as a class, we use
 * a different method for disabling them.
 */
function disableInlineRadio(inputID) {
    $("#" + inputID).prop("disabled", true);
}

function enableInlineRadio(inputID) {
    $("#" + inputID).prop("disabled", false);
}

/* Disables some "volatile" controls in the graph. Should be used when doing
 * any sort of operation, I guess. */
function disableVolatileControls() {
    disableButton("settingsButton");
    $("#componentselector").prop("disabled", true);
    disableButton("decrCompRankButton");
    disableButton("incrCompRankButton");
    disableButton("drawButton");
    $("#SPQRcomponentselector").prop("disabled", true);
    disableButton("decrSPQRCompRankButton");
    disableButton("incrSPQRCompRankButton");
    disableButton("drawSPQRButton");
    disableButton("implicitSPQROption");
    disableButton("explicitSPQROption");
    disableButton("fileselectButton");
    disableButton("loadDBbutton");
    disableButton("xmlFileselectButton");
    $("#searchInput").prop("disabled", true);
    $("#layoutInput").prop("disabled", true);
    disableButton("filterEdgesButton");
    disableButton("reduceEdgesButton");
    disableButton("layoutButton");
    disableButton("scaffoldFileselectButton");
    disableButton("startFinishingButton");
    disableButton("endFinishingButton");
    disableButton("exportPathButton");
    disableButton("agpOption");
    disableButton("csvOption");
    disableButton("floatingExportButton");
    $("#assembledNodes").empty();
    disableButton("searchButton");
    disableButton("collapseButton");
    disableButton("fitSelectedButton");
    disableButton("fitButton");
    disableButton("exportImageButton");
    disableButton("dir0");
    disableButton("dir90");
    disableButton("dir180");
    disableButton("dir270");
    disableButton("pngOption");
    disableButton("jpgOption");
    disableButton("changeNodeColorizationButton");
    disableInlineRadio("noneColorization");
    disableInlineRadio("gcColorization");
    disableInlineRadio("repeatColorization");
    disableInlineRadio("geneColorization");
    disableInlineRadio("depthColorization");
    clearSelectedInfo();
}

/* Displays a status message in the #textStatus <div>.
 * If notDuringDrawing is false, then these messages will not be displayed if
 * the #useDrawingStatusTextCheckbox is unchecked.
 */
function updateTextStatus(text, notDuringDrawing) {
    if(notDuringDrawing || $("#useDrawingStatusTextCheckbox").prop("checked")){
        $("#textStatus").html(text);
    }
}

function toggleHEV() {
    HIDE_EDGES_ON_VIEWPORT = !HIDE_EDGES_ON_VIEWPORT;
}
function toggleUTV() {
    TEXTURE_ON_VIEWPORT = !TEXTURE_ON_VIEWPORT;
}

/* Returns null if the value indicated by the string is not an integer (we
 * consider a string to be an integer if it matches the INTEGER_RE regex).
 * Returns -1 if it is an integer but is less than the min component rank.
 * Returns 1 if it is an integer but is greater than the max component rank.
 * Returns 0 if it is an integer and is within the range [min rank, max rank].
 *
 * (The min/max component rank values are obtained from $(csIDstr) -- it's
 * assumed csIDstr is some string of the format "#xyz" where xyz corresponds to
 * the ID of some input element with min/max properties.)
 *
 * We use this instead of just parseInt() because parseInt is (IMO) too
 * lenient when parsing integer values from strings, which can cause confusion
 * for users (e.g. a user enters in "2c" as a connected component and
 * component 2 is drawn, leading the user to somehow think that "2c" is a valid
 * connected component size rank).
 */
function compRankValidity(strVal, csIDstr) {
    if (strVal.match(INTEGER_RE) === null) return null;
    var intVal = parseInt(strVal);
    if (intVal < parseInt($(csIDstr).prop("min"))) return -1;
    if (intVal > parseInt($(csIDstr).prop("max"))) return 1;
    return 0;
}

/* Decrements the size rank of the component selector by 1. If the current
 * value of the component selector is not an integer, then the size rank is set
 * to the minimum size rank; if the current value is an integer that is greater
 * than the maximum size rank, then the size rank is set to the maximum size
 * rank.
 *
 * Also, if the size rank is equal to the minimum size rank, nothing happens.
 */
function decrCompRank(componentSelectorID) {
    var csIDstr = "#" + componentSelectorID;
    var currRank = $(csIDstr).val();
    var minRank = parseInt($(csIDstr).prop("min"));
    var validity = compRankValidity(currRank, csIDstr);
    if (validity === null || parseInt(currRank) < (minRank + 1)) {
        $(csIDstr).val(minRank);
    }
    else if (validity === 1) {
        $(csIDstr).val($(csIDstr).prop("max"));
    }
    else {
        $(csIDstr).val(parseInt(currRank) - 1);
    }
}

/* Increments the size rank of the component selector by 1. Same "limits" as
 * in the first paragraph of decrCompRank()'s comments.
 *
 * Also, if the size rank is equal to the maximum size rank, nothing happens.
 */
function incrCompRank(componentSelectorID) {
    var csIDstr = "#" + componentSelectorID;
    var currRank = $(csIDstr).val();
    var maxRank = parseInt($(csIDstr).prop("max"));
    var validity = compRankValidity(currRank, csIDstr);
    if (validity === null || validity === -1) {
        $(csIDstr).val($(csIDstr).prop("min"));
    }
    else if (currRank > (maxRank - 1)) {
        $(csIDstr).val(maxRank);
    }
    else {
        $(csIDstr).val(parseInt(currRank) + 1);
    }
}

/* If mode == "SPQR", begins drawing the SPQR-integrated component of the
 * corresponding component rank selector; else, draws a component of the normal
 * (double) graph.
 */
function startDrawComponent(mode) {
    startDrawDate = new Date();
    var selector = "#componentselector";
    var drawFunc = drawComponent;
    if (mode == "SPQR") {
        selector = "#SPQRcomponentselector";
        drawFunc = drawSPQRComponent;
    }
    var currRank = $(selector).val();
    if (compRankValidity(currRank, selector) !== 0) {
        alert("Please enter a valid component rank using the input field.");
        return;
    }
    // if compRankValidity === 0, then currRank must represent just an
    // integer: so parseInt is fine to run on it
    updateTextStatus("Drawing clusters...", false);
    window.setTimeout(drawFunc(parseInt(currRank)), 0);
}

/* Draws the selected connected component of the SPQR view. */
function drawSPQRComponent(cmpRank) {
    // I copied most of this function from drawComponent() and pared it down to
    // what we need for this use-case; sorry it's a bit gross
    disableVolatileControls();
    if (cy !== null) {
        destroyGraph();
    }
    initGraph("SPQR");
    CURR_SPQRMODE = $("#decompositionOptionButtonGroup .btn.active")
            .attr("value");
    setGraphBindings();
    var componentNodeCount = 0;
    var componentEdgeCount = 0;
    // Clear selected element information
    SELECTED_NODES = cy.collection();
    SELECTED_EDGES = cy.collection();
    SELECTED_CLUSTERS = cy.collection();
    SELECTED_NODE_COUNT = 0;
    SELECTED_EDGE_COUNT = 0;
    SELECTED_CLUSTER_COUNT = 0;
    COMPONENT_EDGE_WEIGHTS = [];
    $("#selectedNodeBadge").text(0);
    $("#selectedEdgeBadge").text(0);
    $("#selectedClusterBadge").text(0);
    BICOMPONENTID2VISIBLESINGLENODEIDS = {};
    $("#searchForElementsControls").addClass("notviewable");
    $("#assemblyFinishingControls").addClass("notviewable");
    $("#viewScaffoldsControls").addClass("notviewable");
    $("#testLayoutsControls").addClass("notviewable");
    $("#collapseButtonControls").addClass("notviewable");
    $("#noneColorization").prop("checked", true);
    CURR_NODE_COLORIZATION = "noncolorized";
    PREV_ROTATION = 0;
    CURR_ROTATION = 90;
    cy.scratch("_collapsed", cy.collection());
    cy.scratch("_uncollapsed", cy.collection());
    cy.scratch("_ele2parent", {});
    // Now we render the nodes, edges, and clusters of this component.
    // But first we need to get the bounding box of this component.
    // Along with the component's total node count.
    var query;
    if (CURR_SPQRMODE === "explicit") {
        query = "SELECT boundingbox_x, boundingbox_y,"
            + " ex_uncompressed_node_count, ex_uncompressed_edge_count,"
            + " compressed_node_count, compressed_edge_count,"
            + " bicomponent_count FROM singlecomponents WHERE size_rank = ?"
            + " LIMIT 1";
    }
    else {
        query = "SELECT i_boundingbox_x, i_boundingbox_y,"
            + " im_uncompressed_node_count, im_uncompressed_edge_count,"
            + " compressed_node_count, compressed_edge_count,"
            + " bicomponent_count FROM singlecomponents"
            + " WHERE size_rank = ? LIMIT 1";
    }
    var bbStmt = CURR_DB.prepare(query, [cmpRank]);
    bbStmt.step();
    var fullObj = bbStmt.getAsObject();
    bbStmt.free();
    var bb;
    if (CURR_SPQRMODE === "explicit") {
        bb = {'boundingbox_x': fullObj['boundingbox_x'],
              'boundingbox_y': fullObj['boundingbox_y']};
    }
    else {
        bb = {'boundingbox_x': fullObj['i_boundingbox_x'],
              'boundingbox_y': fullObj['i_boundingbox_y']};
    }
    var bicmpCount = fullObj['bicomponent_count'];
    // the compressed counts are the amounts of nodes and edges that'll be
    // drawn when the graph is first drawn (and all the SPQR trees are
    // collapsed to their root).
    // the uncompressed counts are the amounts of nodes and edges in the
    // graph total (i.e. how many of each are displayed when all the SPQR
    // trees are fully uncollapsed).
    // Note that "nodes" here only refers to normal contigs, not metanodes.
    // However, "edges" here do include edges between metanodes.
    // (if that distinction turns out to be troublesome, we can change it)
    var cNodeCount = fullObj['compressed_node_count'];
    var cEdgeCount = fullObj['compressed_edge_count'];
    // "totalElementCount" is the max value on the progress bar while first
    // drawing this component
    var totalElementCount = (0.5 * cEdgeCount) + (cNodeCount);
    var ucNodeCount = null;
    var ucEdgeCount = null;
    if (CURR_SPQRMODE === "explicit") {
        ucNodeCount = fullObj['ex_uncompressed_node_count'];
        ucEdgeCount = fullObj['ex_uncompressed_edge_count'];
    }
    else {
        ucNodeCount = fullObj['im_uncompressed_node_count'];
        ucEdgeCount = fullObj['im_uncompressed_edge_count'];
    }
    // Scale PROGRESS_BAR_FREQ relative to component size of nodes/edges
    // This does ignore metanodes/bicomponents, but it's a decent approximation
    PROGRESSBAR_FREQ= Math.floor(PROGRESSBAR_FREQ_PERCENT * totalElementCount);
    // for calculating edge control point weight/distance
    var node2pos = {};
    // We check to see if the component contains >= 1 bicomponent. If so, we
    // enable the collapse/uncollapse button; if not, we don't bother
    // enabling the button and keep it disabled because it'd be useless.
    // (We only need to check the bicomponents since metanodes will only be
    // present in a SPQR-view connected component if there are also
    // bicomponents [i.e. SPQR trees] for those metanodes to reside in.)
    var bicmpsInComponent = false;
    // Draw biconnected components.
    cy.startBatch();
    var bicmpsStmt = CURR_DB.prepare(
        "SELECT * FROM bicomponents WHERE scc_rank = ?", [cmpRank]);
    var bicmpObj;
    var metanodeParams = [cmpRank];
    var rootmnQuestionMarks = "(?,";
    while (bicmpsStmt.step()) {
        bicmpsInComponent = true;
        bicmpObj = bicmpsStmt.getAsObject();
        renderClusterObject(bicmpObj, bb, "bicomponent");
        metanodeParams.push(bicmpObj['root_metanode_id']);
        rootmnQuestionMarks += "?,";
    }
    bicmpsStmt.free();
    rootmnQuestionMarks = rootmnQuestionMarks.substr(
            0, rootmnQuestionMarks.lastIndexOf(",")) + ")";
    // Draw metanodes.
    var da;
    // select only the root metanodes from this connected component
    var metanodesStmt = CURR_DB.prepare(
        "SELECT * FROM metanodes WHERE scc_rank = ? AND metanode_id IN"
        + rootmnQuestionMarks, metanodeParams);
    while (metanodesStmt.step()) {
        da = renderClusterObject(metanodesStmt.getAsObject(), bb, "metanode");
        // Use the return value of renderClusterObject() to update node2pos
        // (we don't do this for bicomponents because the edges incident on
        // those are all drawn as basicbeziers, so there's no need to know
        // bicomponents' positions)
        node2pos[da[0]] = da[1];
    }
    metanodesStmt.free();
    // Draw graph "iteratively" -- display all clusters.
    drawBoundingBoxEnforcingNodes(bb);
    cy.endBatch();
    cy.fit();
    // Draw single nodes.
    updateTextStatus("Drawing nodes...", false);
    window.setTimeout(function() {
        cy.startBatch();
        var spqrSpecs = "WHERE scc_rank = ? AND (parent_metanode_id IS NULL "
            + "OR parent_metanode_id IN" + rootmnQuestionMarks + ")";
        var nodesStmt = CURR_DB.prepare(
            "SELECT * FROM singlenodes " + spqrSpecs, metanodeParams);
        CURR_NE = 0;
        // Draw all single nodes. After that's done, we'll draw all metanode
        // edges, and then all single edges.
        drawComponentNodes(nodesStmt, bb, cmpRank, node2pos,
            bicmpsInComponent, componentNodeCount, componentEdgeCount,
            totalElementCount, "SPQR", spqrSpecs, metanodeParams,
            [cNodeCount, cEdgeCount, ucNodeCount, ucEdgeCount, bicmpCount]);
    }, 0);
}

/* Draws the selected connected component in the .db file -- its nodes, its
 * edges, its clusters -- to the screen.
 */
function drawComponent(cmpRank) {
    disableVolatileControls();
    // Okay, we can draw this component!
    if (cy !== null) {
        // If we already have a graph instance, clear that graph before
        // initializing another one
        // This should have already been called in parseDBcomponents(),
        // but since you can draw multiple components for the same .db file
        // we include this here as well
        destroyGraph();
    }
    initGraph("double");
    setGraphBindings();
    var componentNodeCount = 0;
    var componentEdgeCount = 0;
    SELECTED_NODES = cy.collection();
    SELECTED_EDGES = cy.collection();
    SELECTED_CLUSTERS = cy.collection();
    COMPONENT_EDGE_WEIGHTS = [];
    $("#scaffoldCycler").addClass("notviewable");
    // will be set to true if we find suitable scaffolds
    // the actual work of finding those scaffolds (if SCAFFOLDID2NODEKEYS is
    // not empty, of course) is done in finishDrawComponent().
    COMPONENT_HAS_SCAFFOLDS = false;
    $("#scaffoldInfoHeader").addClass("notviewable");
    COMPONENT_NODE_KEYS = [];
    $("#assembledNodes").empty();
    FINISHING_MODE_ON = false;
    FINISHING_MODE_PREVIOUSLY_DONE = false;
    FINISHING_NODE_IDS = "";
    FINISHING_NODE_OBJS = [];
    NEXT_NODES = cy.collection();
    FINISHING_LINEAR_CYCLE = false;
    SELECTED_NODE_COUNT = 0;
    SELECTED_EDGE_COUNT = 0;
    SELECTED_CLUSTER_COUNT = 0;
    REMOVED_EDGES = cy.collection();
    $("#selectedNodeBadge").text(0);
    $("#selectedEdgeBadge").text(0);
    $("#selectedClusterBadge").text(0);
    BICOMPONENTID2VISIBLESINGLENODEIDS = {};
    // Set the controls that aren't viewable in the SPQR view to be viewable,
    // since we're not drawing the SPQR view
    $("#searchForElementsControls").removeClass("notviewable");
    $("#assemblyFinishingControls").removeClass("notviewable");
    $("#viewScaffoldsControls").removeClass("notviewable");
    $("#testLayoutsControls").removeClass("notviewable");
    $("#collapseButtonControls").removeClass("notviewable");
    // Disable other node colorization settings and check the "noncolorized"
    // node colorization option by default
    $("#noneColorization").prop("checked", true);
    CURR_NODE_COLORIZATION = "noncolorized";
    PREV_ROTATION = 0;
    // NOTE -- DISABLED ROTATION -- to allow rotation uncomment below and
    // replace CURR_ROTATION = 90 line
    //CURR_ROTATION = parseInt($("#rotationButtonGroup .btn.active")
    //    .attr("value"));
    CURR_ROTATION = 90;
    cy.scratch("_collapsed", cy.collection());
    cy.scratch("_uncollapsed", cy.collection());
    cy.scratch("_ele2parent", {});
    // Now we render the nodes, edges, and clusters of this component.
    // But first we need to get the bounding box of this component.
    // Along with the component's total node count.
    var bbStmt = CURR_DB.prepare(
        "SELECT boundingbox_x, boundingbox_y, node_count, edge_count FROM components WHERE " +
        "size_rank = ? LIMIT 1", [cmpRank]);
    bbStmt.step();
    var fullObj = bbStmt.getAsObject();
    bbStmt.free();
    var bb = {'boundingbox_x': fullObj['boundingbox_x'],
              'boundingbox_y': fullObj['boundingbox_y']};
    var totalElementCount = fullObj['node_count'] +
        (0.5 * fullObj['edge_count']); 
    // here we scale PROGRESSBAR_FREQ to totalElementCount for the
    // component to be drawn (see top of file for reference)
    // As we draw other components later within the same session of the viewer
    // application, PROGRESSBAR_FREQ will be updated accordingly
    PROGRESSBAR_FREQ= Math.floor(PROGRESSBAR_FREQ_PERCENT * totalElementCount);
    // We need a fast way to associate node IDs with their x/y positions.
    // This is for calculating edge control point weight/distance.
    // And doing 2 DB queries (src + tgt) for each edge will take a lot of
    // time -- O(2|E|) time, specifically, with the only benefit of not
    // taking up a lot of space. So we go with the mapping solution -- it's
    // not particularly pretty, but it works alright.
    var node2pos = {};
    // We check to see if the component contains >= 1 cluster. If so, we
    // enable the collapse/uncollapse button; if not, we don't bother
    // enabling the button and keep it disabled because it'd be useless
    var clustersInComponent = false;
    cy.startBatch();
    var clustersStmt = CURR_DB.prepare(
        "SELECT * FROM clusters WHERE component_rank = ?", [cmpRank]);
    while (clustersStmt.step()) {
        clustersInComponent = true;
        renderClusterObject(clustersStmt.getAsObject(), bb, "cluster");
    }
    clustersStmt.free();
    // Draw graph "iteratively" -- display all clusters.
    drawBoundingBoxEnforcingNodes(bb);
    cy.endBatch();
    cy.fit();
    updateTextStatus("Drawing nodes...", false);
    window.setTimeout(function() {
        /* I originally didn't have this wrapped in a timeout, but for some
         * reason a few clusters in the test BAMBUS E. coli assembly weren't
         * being rendered at the waiting point. It seemed some sort of race
         * condition was happening, and wrapping this block of code in a
         * timeout seems to solve the problem for iterative cluster drawing
         * (iterative node/edge drawing is fine, since those already use
         * timeouts to update the progress bar).
         */
        cy.startBatch();
        var nodesStmt = CURR_DB.prepare(
            "SELECT * FROM nodes WHERE component_rank = ?", [cmpRank]);
        CURR_NE = 0;
        drawComponentNodes(nodesStmt, bb, cmpRank, node2pos,
            clustersInComponent, componentNodeCount, componentEdgeCount,
            totalElementCount, "double", "", [], []);
    }, 0);
}

/* Draws nodes in the component, then switches to drawing edges.
 * If mode is "SPQR" then this will handle those nodes' IDs/etc. specially.
 * Otherwise, it's assumed that nodes are in a normal double graph.
 *
 * (If mode is "SPQR" then spqrSpecs is interpreted as a string that can be
 * suffixed to a SQLite query for selecting singlenodes/singleedges, and
 * metanodeParams is interpreted as an array of cmpRank followed by all the
 * root metanode IDs. counts will also be interpreted as an array of
 * [compressed node count, compressed edge count, uncompressed node count,
 * uncompressed edge count, bicomponent count].
 * If mode is not "SPQR" then those three values aren't used.)
 *
 * (sorry this code wound up being ugly)
 */
function drawComponentNodes(nodesStmt, bb, cmpRank, node2pos,
        clustersInComponent, componentNodeCount, componentEdgeCount,
        totalElementCount, mode, spqrSpecs, metanodeParams, counts) {
    if (nodesStmt.step()) {
        var currNode = nodesStmt.getAsObject();
        var currNodeID = currNode['id'];
        var parentMetaNodeID = currNode['parent_metanode_id'];
        // Render the node object and save its position
        if (mode === "SPQR" && parentMetaNodeID !== null) {
            // It's possible for us to have duplicates of this node, in this
            // case. We construct this node's ID in Cytoscape.js as its actual
            // ID suffixed by its parent metanode ID in order to disambiguate
            // it from other nodes with the same ID in different metanodes.
            currNodeID += ("_" + parentMetaNodeID);
        }
        node2pos[currNodeID]= renderNodeObject(currNode, currNodeID, bb, mode);
        componentNodeCount += 1;
        CURR_NE += 1;
        if (CURR_NE % PROGRESSBAR_FREQ === 0) {
            updateProgressBar((CURR_NE / totalElementCount) * 100);
            window.setTimeout(function() {
                drawComponentNodes(nodesStmt, bb, cmpRank, node2pos,
                    clustersInComponent, componentNodeCount,
                    componentEdgeCount, totalElementCount, mode, spqrSpecs,
                    metanodeParams, counts);
            }, 0);
        }
        else {
            drawComponentNodes(nodesStmt, bb, cmpRank, node2pos,
                clustersInComponent, componentNodeCount, componentEdgeCount,
                totalElementCount, mode, spqrSpecs, metanodeParams, counts);
        }
    }
    else {
        nodesStmt.free();
        // Second part of "iterative" graph drawing: draw all edges
        cy.endBatch();
        cy.fit();
        updateTextStatus("Drawing edges...", false);
        cy.startBatch();
        // NOTE that we intentionally only consider edges within this component
        // Multiplicity is an inherently relative measure, so outliers in other
        // components will just mess things up in the current component.
        var edgesStmt;
        var edgeType = "doubleedge";
        if (mode !== "SPQR") {
            edgesStmt = CURR_DB.prepare(
                "SELECT * FROM edges WHERE component_rank = ?", [cmpRank]);
        }
        else {
            // Our use of spqrSpecs and metanodeParams in constructing this
            // query is the only reason we bother passing them to
            // drawComponentNodes() after we used them earlier to construct the
            // query on singlenodes. Now that we have edgesStmt ready, we don't
            // need to bother saving spqrSpecs and metanodeParams.
            edgeType = "singleedge";
            edgesStmt = CURR_DB.prepare(
                "SELECT * FROM singleedges " + spqrSpecs, metanodeParams);
            // NOTE don't draw metanodeedges by default due to autocollapsing
        }
        drawComponentEdges(edgesStmt, bb, node2pos, cmpRank,
            clustersInComponent, componentNodeCount, componentEdgeCount,
            totalElementCount, edgeType, mode, counts);
    }
}

// If edgeType !== "double" then draws edges accordingly
// related: if mode === "SPQR" then draws edges accordingly
// also if mode === "SPQR" then passes counts on to finishDrawComponent()
function drawComponentEdges(edgesStmt, bb, node2pos, cmpRank,
        clustersInComponent, componentNodeCount, componentEdgeCount,
        totalElementCount, edgeType, mode, counts) {
    if (edgesStmt.step()) {
        renderEdgeObject(edgesStmt.getAsObject(), node2pos, bb, edgeType,
                mode, {});
        componentEdgeCount += 1;
        CURR_NE += 0.5;
        if (CURR_NE % PROGRESSBAR_FREQ === 0) {
            updateProgressBar((CURR_NE / totalElementCount) * 100);
            window.setTimeout(function() {
                drawComponentEdges(edgesStmt, bb, node2pos,
                    cmpRank, clustersInComponent, componentNodeCount,
                    componentEdgeCount, totalElementCount, edgeType, mode,
                    counts);
            }, 0);
        }
        else {
            drawComponentEdges(edgesStmt, bb, node2pos,
                cmpRank, clustersInComponent, componentNodeCount,
                componentEdgeCount, totalElementCount, edgeType, mode, counts);
        }
    }
    else {
        edgesStmt.free();
        CURR_BOUNDINGBOX = bb;
        finishDrawComponent(cmpRank, componentNodeCount, componentEdgeCount,
            clustersInComponent, mode, counts);
    }
}

// Updates a paragraph contained in the assembly info dialog with some general
// information about the current connected component.
function updateCurrCompInfo(cmpRank, componentNodeCount, componentEdgeCount,
        mode, counts) {
    var intro = "The ";
    var nodePercentage, edgePercentage;
    if (mode !== "SPQR") {
        var nodePercentage = (componentNodeCount / ASM_NODE_COUNT) * 100;
        var edgePercentage = (componentEdgeCount / ASM_EDGE_COUNT) * 100;
    }
    var all_nodes_edges_modifier = "the";
    if (mode !== "SPQR" && $("#filetypeEntry").text() !== "GML") {
        intro = "Including <strong>both positive and negative</strong>" +
            " nodes and edges, the ";
        nodePercentage /= 2;
        all_nodes_edges_modifier = "all positive and negative";
    }
    // This is incredibly minor, but I always get annoyed at software that
    // doesn't use correct grammar for stuff like this nowadays :P
    var bodyText = intro + "current connected component (size rank <strong>"
        + cmpRank + "</strong>) ";
    if (mode === "SPQR") {
        bodyText += "in the SPQR view, when fully collapsed, has <strong>"
            + counts[0] + " " + getSuffix(counts[0], "node") + "</strong> and "
            + "<strong>" + counts[1] + " " + getSuffix(counts[1], "edge")
            + "</strong>. When fully " + CURR_SPQRMODE + "ly uncollapsed, "
            + "the connected component has <strong>"
            + counts[2] + " " + getSuffix(counts[2], "node") + "</strong> and "
            + "<strong>" + counts[3] + " " + getSuffix(counts[3], "edge")
            + "</strong>. The connected component has <strong>" + counts[4]
            + " " + getSuffix(counts[4], "biconnected component")
            + "</strong>. ";
        if (CURR_SPQRMODE === "explicit") {
            bodyText+= "(These figures do not include SPQR tree metanodes, "
                + "although they do include the edges between them when "
                + "uncollapsed.)";
        }
    }
    else {
        var nodeNoun = getSuffix(componentNodeCount, "node");
        var edgeNoun = getSuffix(componentEdgeCount, "edge");
        bodyText += "has <strong>" + componentNodeCount + " " + nodeNoun
            + "</strong> and <strong>" + componentEdgeCount + " " + edgeNoun
            + "</strong>. This connected component contains <strong>"
            + nodePercentage.toFixed(2) + "% of " + all_nodes_edges_modifier
            + " nodes</strong> in the assembly and <strong>"
            + edgePercentage.toFixed(2) + "% of " + all_nodes_edges_modifier
            + " edges</strong> in the assembly.";
    }
    $("#currComponentInfo").html(bodyText);
}

function getSuffix(countOfSomething, noun) {
    return (countOfSomething === 1) ? noun : noun + "s";
}

function finishDrawComponent(cmpRank, componentNodeCount, componentEdgeCount,
        clustersInComponent, mode, counts) {
    updateCurrCompInfo(cmpRank, componentNodeCount, componentEdgeCount, mode,
        counts);
    // NOTE modified initClusters() to do cluster height after the fact.
    // This represents an inefficiency when parsing xdot files, although it
    // shouldn't really affect anything major.
    if (mode !== "SPQR") {
        initClusters();
    }
    cy.endBatch();
    cy.fit();
    // we do this after fitting to ensure the best precision possible
    // (also, this helps when drawing collapsed SPQR trees. See the MaryGold
    // test graph as a good example of why this is needed)
    cy.batch(function() { removeBoundingBoxEnforcingNodes(); });
    // Set minZoom to whatever the zoom level when viewing the entire drawn
    // component at once (i.e. right now) is
    cy.minZoom(cy.zoom());
    updateTextStatus("Preparing interface...", false);
    window.setTimeout(function() {
        // If we have scaffold data still loaded for this assembly, use it
        // for the newly drawn connected component.
        if (isObjectNonempty(SCAFFOLDID2NODEKEYS)) {
            updateScaffoldsInComponentList();
        }
        // At this point, all of the hard work has been done. All that's left
        // to do now is re-enable controls, enable graph interaction, etc.
        $("#componentselector").prop("disabled", false);
        enableButton("decrCompRankButton");
        enableButton("incrCompRankButton");
        enableButton("drawButton");
        $("#SPQRcomponentselector").prop("disabled", false);
        enableButton("decrSPQRCompRankButton");
        enableButton("incrSPQRCompRankButton");
        enableButton("drawSPQRButton");
        enableButton("implicitSPQROption");
        enableButton("explicitSPQROption");
        enableButton("fileselectButton");
        enableButton("loadDBbutton");
        enableButton("xmlFileselectButton");
        $("#searchInput").prop("disabled", false);
        $("#layoutInput").prop("disabled", false);
        if (ASM_FILETYPE === "LastGraph" || ASM_FILETYPE === "GML") {
            // Only enable the edge filtering features for graphs that have
            // edge weights (multiplicity or bundle size)
            enableButton("filterEdgesButton");
        }
        if (componentEdgeCount > 0) {
            enableButton("reduceEdgesButton");
        }
        enableButton("layoutButton");
        enableButton("scaffoldFileselectButton");
        enableButton("startFinishingButton");
        enableButton("agpOption");
        enableButton("csvOption");
        enableButton("searchButton");
        enableButton("fitButton");
        enableButton("exportImageButton");
        enableButton("floatingExportButton");
        enableButton("dir0");
        enableButton("dir90");
        enableButton("dir180");
        enableButton("dir270");
        enableButton("pngOption");
        enableButton("jpgOption");
        if (DNA_AVAILABLE || REPEAT_INFO_AVAILABLE) {
            enableButton("changeNodeColorizationButton");
            enableInlineRadio("noneColorization");
            if (DNA_AVAILABLE) {
                // GC content is available
                enableInlineRadio("gcColorization");
            }
            if (REPEAT_INFO_AVAILABLE) {
                enableInlineRadio("repeatColorization");
            }
        }
        enableButton("settingsButton");
        cy.userPanningEnabled(true);
        cy.userZoomingEnabled(true);
        cy.boxSelectionEnabled(true);
        cy.autounselectify(false);
        cy.autoungrabify(false);
        if (clustersInComponent) {
            enableButton("collapseButton");
        }
        else {
            disableButton("collapseButton");
        }
        updateTextStatus("&nbsp;", false);
        finishProgressBar();
        endDrawDate = new Date();
        var drawTime = endDrawDate.getTime() - startDrawDate.getTime();
        console.log("Drawing took " + drawTime + "ms");
    }, 0);
}

/* Returns true if the specified object is not empty, false otherwise.
 * (We assume that the object is just a normal "mapping." This is only really
 * intended to work for SCAFFOLDID2NODEKEYS at present -- I can't guarantee
 * it'll work for other JavaScript objects.)
 */
function isObjectNonempty(object) {
    for (var k in object) {
        return true;
    }
    return false;
}

// TODO verify that this doesn't mess stuff up when you back out of and then
// return to the page. Also are memory leaks even a thing that we have
// to worry about in Javascript?????????
function closeDB() {
    if (CURR_DB !== null) {
        CURR_DB.close();
    }
}

function changeDropdownVal(arrowHTML) {
    $("#rotationDropdown").html(arrowHTML + " <span class='caret'></span>"); 
}

// Toggle visibility of the controls div.
function toggleControls() {
    $("#controls").toggleClass("notviewable");
    $("#cy").toggleClass("nosubsume");
    $("#cy").toggleClass("subsume");
    if (cy !== null) {
        cy.resize();
    }
}

function openFileSelectDialog() {
    $("#fsDialog").modal(); 
}

/* Loads a .db file using an XML HTTP Request. */
function loadajaxDB() {
    // Important -- remove old DB from memory if it exists
    closeDB();
    // usually we won't have the luxury of ID === filename, but this is a
    // demo so might as well
    $("#fsDialog").modal("hide");
    disableVolatileControls();
    $("#selectedNodeBadge").text(0);
    $("#selectedEdgeBadge").text(0);
    $("#selectedClusterBadge").text(0);
    disableButton("infoButton");
    $("#currComponentInfo").html(
        "No connected component has been drawn yet.");
    var filename = $("input[name=fs]:checked").attr('id');
    DB_FILENAME = filename;
    // jQuery doesn't support arraybuffer responses so we have to manually
    // use an XMLHttpRequest(), strange capitalization and all
    // Credit to this approach goes here, btw:
    // http://www.henryalgus.com/reading-binary-files-using-jquery-ajax/
    var xhr = new XMLHttpRequest();
    xhr.open("GET", filename, true);
    xhr.responseType = 'arraybuffer';
    xhr.onload = function(eve) {
        if (this.status === 200) {
            loadDBfile(this.response);
        }
    };
    startIndeterminateProgressBar();
    xhr.send();
}

// Given percentage lies within [0, 100]
function updateProgressBar(percentage) {
    $(".progress-bar").css("width", percentage + "%");
    $(".progress-bar").attr("aria-valuenow", percentage);
}

function finishProgressBar() {
    // We call updateProgressBar since, depending on the progress bar update
    // frequency in the process that was ongoing before finishProgressBar() is
    // called, the progress bar could be at a value less than 100%. So we call
    // updateProgressBar(100) as a failsafe to make sure the progress bar
    // always ends up at 100%, regardless of the update frequency.
    updateProgressBar(100);
    if (!$(".progress-bar").hasClass("notransitions")) {
        $(".progress-bar").addClass("notransitions")
    }
    if ($(".progress-bar").hasClass("progress-bar-striped")) {
        $(".progress-bar").removeClass("progress-bar-striped");
    }
    if ($(".progress-bar").hasClass("active")) {
        $(".progress-bar").removeClass("active");
    }
}

/* Assumes the progress bar is not already indeterminate and that the
 * progress bar is already at 100% width.
 */
function startIndeterminateProgressBar() {
    if ($("#useProgressBarStripesCheckbox").prop("checked")) {
        $(".progress-bar").addClass("active");
        $(".progress-bar").addClass("progress-bar-striped");
        $(".progress-bar").removeClass("notransitions");
    }
}

/* If toDownload is true, calls downloadDataURI(); otherwise, just returns the
 * color settings string. (NOTE -- at present, no other places in the code use
 * this function with toDownload === false; I'm retaining this functionality
 * in case that need comes up in the future, though.)
 */
function exportColorSettings(toDownload) {
    var textToExport = "";
    $(".colorpicker-component").each(function(i) {
        textToExport += this.id +"\t"+ $(this).colorpicker("getValue") + "\n";
    });
    if (toDownload) {
        downloadDataURI("color_settings.tsv", textToExport, true);
    } else {
        return textToExport;
    }
}

/* Resets the color settings to DEFAULT_COLOR_SETTINGS, defined above. */
function resetColorSettings() {
    integrateColorSettings(DEFAULT_COLOR_SETTINGS);
}

/* Given a string containing the entire text of a color settings .tsv file,
 * integrates each line for its respective colorpicker (so, for example,
 * a line consisting of usncp\t#ff0000 will result in the colorpicker with
 * ID "usncp" being set to the color #ff0000).
 */
function integrateColorSettings(fileText) {
    var fileLines = fileText.split("\n");
    for (var n = 0; n < fileLines.length; n++) {
        var lineVals = fileLines[n].split("\t");
        if (lineVals.length !== 2) {
            // ignore lines that don't follow the ID\tCOLOR format
            continue;
        }
        // NOTE at present we don't impose any sort of validation
        // on the color inputs, since invalid colors will just map
        // to #000 (we assume that the imported color settings are
        // correct).
        $("#" + lineVals[0]).colorpicker("setValue", lineVals[1]);
    }
}

/* Imports a color settings .tsv file. Designed to work with .tsv files
 * generated by exportColorSettings(), but the format is simple enough that
 * it'd be certainly possible to create an input file for this manually.
 *
 * This loads the entire file at once instead of using Blobs to read it; this
 * is acceptable because the size of this file is expected to be relatively
 * small. We don't impose a check for file size or anything, although I suppose
 * that might be an option if we want to prevent the user from importing really
 * pointlessly large files?
 * (Granted, the fact that this checks to make sure the input is a .tsv file
 * is probably a sufficient safeguard from that scenario; since this is a
 * client-side application, if the user is really determined to somehow
 * upload a really large file here then this browser tab/instance will just
 * run out of memory, which is an inherently isolated problem.)
 */
function importColorSettings() {
    var csfr = new FileReader();
	var inputfile = document.getElementById('colorSettingsFS').files[0];
    if (inputfile === undefined) {
        return;
    }
    if (inputfile.name.toLowerCase().endsWith(".tsv")) {
        csfr.onload = function(e) {
            if (e.target.readyState === FileReader.DONE) {
                var fileText = e.target.result;
                // read file, synthesize colorpickers
                integrateColorSettings(fileText);
                // Clear .value attr to allow the same file (with changes
                // made) to be uploaded twice in a row
                document.getElementById('colorSettingsFS').value = "";
            }
        }
        csfr.readAsText(inputfile);
    }
    else {
        alert("Please select a valid .tsv color settings file to load.");
    }
}

/* Uses the downloadHelper <a> element to prompt the user to save a data URI
 * to their system.
 *
 * If the isPlainText argument is true, then this will treat contentToDownload
 * as text/plain data (appending the necessary prefixes for constructing a data
 * URI, and calling window.btoa() on contentToDownload).
 * If isPlainText is false, however, then this won't append any prefixes to
 * contentToDownload and won't call window.btoa() on it.
 */
function downloadDataURI(filename, contentToDownload, isPlainText) {
    $("#downloadHelper").attr("download", filename);
    if (isPlainText) {
        var data = "data:text/plain;charset=utf-8;base64," +
            window.btoa(contentToDownload);
        $("#downloadHelper").attr("href", data);
    }
    else {
        $("#downloadHelper").attr("href", contentToDownload);
    }
    document.getElementById("downloadHelper").click();
}

/* Pops up the dialog for color preference selection. */
function displaySettings() {
    $("#settingsDialog").modal();
}

/* Pops up a dialog displaying assembly information. */
function displayInfo() {
    $("#infoDialog").modal();
}

/* eleType can be one of {"node", "edge", "cluster"} */
function toggleEleInfo(eleType) {
    var openerID = "#" + eleType + "Opener";
    var infoDivID = "#" + eleType + "Info";
    if ($(openerID).hasClass("glyphicon-triangle-right")) {
        $(openerID).removeClass("glyphicon-triangle-right"); 
        $(openerID).addClass("glyphicon-triangle-bottom"); 
    }
    else { 
        $(openerID).removeClass("glyphicon-triangle-bottom"); 
        $(openerID).addClass("glyphicon-triangle-right"); 
    }
    $(infoDivID).toggleClass("notviewable");
}

function clearSelectedInfo() {
    $("#nodeInfoTable tr.nonheader").remove();
    $("#edgeInfoTable tr.nonheader").remove();
    $("#clusterInfoTable tr.nonheader").remove();
    if ($("#nodeOpener").hasClass("glyphicon-triangle-bottom")) {
        toggleEleInfo('node');
    }
    if ($("#edgeOpener").hasClass("glyphicon-triangle-bottom")) {
        toggleEleInfo('edge');
    }
    if ($("#clusterOpener").hasClass("glyphicon-triangle-bottom")) {
        toggleEleInfo('cluster');
    }
}

/* Return a single string containing the DNA sequences of the selected
 * nodes, in FASTA format. NOTE that this only works if nodes in the database
 * have a dnafwd column, which (as of June 7, 2017) they don't. Hence why the
 * button for calling this function is disabled at present.
 * (There's some limits on data URI sizes that, given sufficiently large
 * contigs, is relatively easy to hit -- that's why this feature is
 * disabled at present.)
 */
function getSelectedNodeDNA() {
    // Get DNA sequences from database file, and append them to a string
    var dnaStmt;
    var dnaSeqs = "";
    var currDnaSeq;
    var seqIndex;
    var afterFirstSeqLine;
    SELECTED_NODES.each(function(e, i) {
        // Is there any way to make this more efficient? Like, via
        // selecting multiple dnafwd values at once...?
        dnaStmt = CURR_DB.prepare("SELECT dnafwd FROM nodes WHERE id = ?",
            [e.id()]);
        dnaStmt.step();
        if (i > 0) {
            dnaSeqs += "\n";
        }
        dnaSeqs += ">NODE_" + e.id() + "\n";
        afterFirstSeqLine = false;
        currDnaSeq = dnaStmt.getAsObject()['dnafwd'];
        for (seqIndex = 0; seqIndex < currDnaSeq.length; seqIndex += 70) {
            if (afterFirstSeqLine) {
                dnaSeqs += "\n";
            }
            else {
                afterFirstSeqLine = true;
            }
            dnaSeqs += currDnaSeq.substring(seqIndex, seqIndex + 70);
        }
        dnaStmt.free();
    });
    return dnaSeqs;
}
 
/* Exports selected node DNA to a FASTA file via a data URI. */
function exportSelectedNodeDNA() {
    window.open(
        "data:text/FASTA;charset=utf-8;base64," +
        window.btoa(getSelectedNodeDNA()),
        "_blank"
    );
}

/* Fits the graph to all its elements if toSelected is false, and to only
 * selected elements if toSelected is true.
 */
function fitGraph(toSelected) {
    startIndeterminateProgressBar();
    window.setTimeout(
        function() {
            if (toSelected) {
                // Right now, we don't throw any sort of error here if
                // no elements are selected. This is because the fit-selected
                // button is only enabled when >= 1 elements are selected.
                cy.fit(
                    SELECTED_NODES.union(SELECTED_EDGES).union(
                        SELECTED_CLUSTERS)
                );
            } else {
                cy.fit();
            }
            finishProgressBar();
        }, 20
    );
}

/* Exports image of graph. */
function exportGraphView() {
    var imgType = $("#imgTypeButtonGroup .btn.active").attr("value");
    if (imgType === "PNG") {
        downloadDataURI("screenshot.png", cy.png({bg: BG_COLOR}), false);
    }
    else {
        downloadDataURI("screenshot.jpg", cy.jpg({bg: BG_COLOR}), false);
    }
}

/* Opens the dialog for filtering edges. */
function openEdgeFilteringDialog() {
    $("#edgeFilteringDialog").modal();
    drawEdgeWeightHistogram();
}

/* This code was mostly taken from Mike Bostock's example of d3.js' histogram
 * generation, available at https://gist.github.com/mbostock/3048450.
 */
function drawEdgeWeightHistogram() {
    var formatCount = d3.format(",.0f");
    // note could probably find this inline to simplify computation time
    var max = d3.max(COMPONENT_EDGE_WEIGHTS); 
    //console.log(COMPONENT_EDGE_WEIGHTS);
    var margin = {top: 10, right: 30, bottom: 50, left: 70};
    //for (var i = 0; i < COMPONENT_EDGE_WEIGHTS.length; i++) {
    //    console.log(COMPONENT_EDGE_WEIGHTS[i] + "->" + data[i]);
    //}
    // Remove old histogram so that it doesn't get drawn over
    // Eventually we might want to consider only redrawing the histogram when
    // we open up a new cc, but for now it's fine
    d3.select("#edgeWeightChart *").remove();
    var chartSvg = d3.select("#edgeWeightChart");
    var width = +chartSvg.attr("width") - margin.left - margin.right;
    var height = +chartSvg.attr("height") - margin.top - margin.bottom;
    var g = chartSvg.append("g")
        .attr("transform","translate(" + margin.left + "," + margin.top + ")");
    var x = d3.scaleLinear().domain([0, max * 1.1]).rangeRound([0, width]);
    var bin_count = + $("#binCountInput").val();
    var bins = d3.histogram()
        .domain(x.domain())
        .thresholds(x.ticks(bin_count))(COMPONENT_EDGE_WEIGHTS);
    var y = d3.scaleLinear()
        .domain([0, d3.max(bins, function(b) { return b.length; })])
        .range([height, 0]);
    var bar = g.selectAll(".edge_chart_bar")
        .data(bins)
        .enter().append("g")
            .attr("class", "edge_chart_bar")
            .attr("transform",
                    function(b) {
                        return "translate(" + x(b.x0) +","+ y(b.length) + ")";
                    }
            );
    bar.append("rect")
        .attr("x", 1)
        .attr("width", function(d) { return x(d.x1) - x(d.x0) - 1; })
        .attr("height", function(d) { return height - y(d.length); });

    var xAxis = d3.axisBottom(x);
    var yAxis = d3.axisLeft(y);
    g.append("g")
        .attr("class", "axis axis--x")
        .attr("transform", "translate(0," + height + ")")
        .call(xAxis);
    g.append("g")
        .attr("class", "axis axis--y")
        .call(yAxis);
    // Add x-axis label
    g.append("text")
        .attr("transform", "translate(" + (width / 2) + "," +
                (height + margin.top + 30) + ")")
        .style("text-anchor", "middle")
        .text("Edge multiplicity");
    // Add y-axis label
    g.append("text")
        .attr("transform", "rotate(-90)")
        .attr("y", 0 - margin.left)
        .attr("x", 0 - (height / 2))
        .attr("dy", "1em")
        .style("text-anchor", "middle")
        .text("Frequency");
    // TODO: ensure that bars have uniform width?; ensure that the
    // y-axis only has ticks for integer values
}

/* Hides edges below a minimum edge weight (multiplicity or bundle size,
 * depending on the assembly graph that has been loaded).
 * This should only be called if the assembly graph that has been loaded has
 * edge weights as a property (e.g. LastGraph or Bambus 3 GML graphs).
 */
function cullEdges() {
    var strVal = $("#cullEdgesInput").val();
    // Check that the input is a nonnegative integer
    // (parseInt() is pretty lax)
    if (strVal.match(INTEGER_RE) === null) {
        alert("Please enter a valid minimum edge weight (a nonnegative " +
              "integer) using the input field.");
        return;
    }
    var threshold = parseInt(strVal);
    // Use PREV_EDGE_WEIGHT_THRESHOLD to prevent redundant operations being
    // done when the user double-clicks this button
    if (PREV_EDGE_WEIGHT_THRESHOLD !== threshold) {
        cy.startBatch();
        // Restore removed edges that would fit within a lowered threshold
        // Also, remove these edges from REMOVED_EDGES
        var restoredEdges = cy.collection();
        REMOVED_EDGES.each(
            function(e, i) {
                if (e.data("multiplicity") >= threshold) {
                    // If the edge points to/from a node within a collapsed
                    // cluster, then make the edge a basicbezier and move the
                    // edge to point to the cluster accordingly.
                    // TODO, consult point 2 on issue #161
                    if (e.source().removed()) {
                        e.removeClass("unbundledbezier");
                        e.addClass("basicbezier");
                        e.move({source: e.source().data("parent")});
                    }
                    if (e.target().removed()) {
                        e.removeClass("unbundledbezier");
                        e.addClass("basicbezier");
                        e.move({target: e.target().data("parent")});
                    }
                    e.restore();
                    restoredEdges = restoredEdges.union(e);
                }
            }
        );
        REMOVED_EDGES = REMOVED_EDGES.difference(restoredEdges);
        // Remove edges that have multiplicity less than the specified
        // threshold
        cy.$("edge").each(
            function(e, i) {
                var mult = e.data("multiplicity");
                if (mult !== null && mult < threshold) {
                    if (e.selected())
                        e.unselect();
                    REMOVED_EDGES = REMOVED_EDGES.union(e.remove());
                }
            }
        );
        cy.endBatch();
        PREV_EDGE_WEIGHT_THRESHOLD = threshold;
    }
}

function beginLoadAGPfile() {
    var sfr = new FileReader();
    // will be set to true if we find suitable scaffolds
    COMPONENT_HAS_SCAFFOLDS = false;
	var inputfile = document.getElementById('scaffoldFileSelector').files[0];
    if (inputfile === undefined) {
        return;
    }
    if (inputfile.name.toLowerCase().endsWith(".agp")) {
        // The file is valid. We can load it.
        startIndeterminateProgressBar();
        SCAFFOLDID2NODEKEYS = {};
        $("#scaffoldInfoHeader").addClass("notviewable");
        $("#scaffoldCycler").addClass("notviewable");
        // Set some attributes of the FileReader object that we update while
        // reading the file.
        sfr.nextStartPosition = 0;
        sfr.partialLine = "";
        sfr.readingFinalBlob = false;
        // This is called after every Blob (manageably-sized chunk of the file)
        // is loaded via this FileReader object.
        sfr.onload = function(e) {
            if (e.target.readyState === FileReader.DONE) {
                var blobText = e.target.result;
                var blobLines = blobText.split("\n");
                // Newlines located at the very start or end of blobText will
                // cause .split() to add "" in those places, which makes
                // integrating sfr.partialLine with this a lot easier.
                // (As opposed to us having to manually check for newlines in
                // those places.)
                var c;
                if (blobLines.length > 1) {
                    // Process first line, which may or may not include
                    // sfr.partialLine's contents (sfr.partialLine may be "",
                    // or blobLines[0] may be "").
                    c = integrateAGPline(sfr.partialLine + blobLines[0]);
                    if (c !== 0) {
                        clearScaffoldFS(true);
                        return;
                    }
                    sfr.partialLine = "";
                    // Process "intermediate" lines
                    for (var i = 1; i < blobLines.length - 1; i++) {
                        c = integrateAGPline(blobLines[i]);
                        if (c !== 0) {
                            clearScaffoldFS(true);
                            return;
                        }
                    }
                    // Process last line in the blob: if we know this is the
                    // last Blob we can read then we treat this last line as a
                    // complete line. Otherwise, we just store it in
                    // sfr.partialLine.
                    if (sfr.readingFinalBlob) {
                        c = integrateAGPline(blobLines[blobLines.length - 1]);
                        if (c !== 0) {
                            clearScaffoldFS(true);
                            return;
                        }
                    }
                    else {
                        sfr.partialLine = blobLines[blobLines.length - 1];
                    }
                }
                else if (blobLines.length === 1) {
                    // blobText doesn't contain any newlines
                    if (sfr.readingFinalBlob) {
                        c = integrateAGPline(sfr.partialLine + blobText);
                        if (c !== 0) {
                            clearScaffoldFS(true);
                            return;
                        }
                    }
                    else {
                        sfr.partialLine += blobText;
                    }
                }
                loadAGPfile(this, inputfile, this.nextStartPosition);
            }
        }
        // use a small timeout so the call to startIndeterminateProgressBar()
        // can update the DOM
        $("#agpLoadedFileName").addClass("notviewable");
        window.setTimeout(function() {
            loadAGPfile(sfr, inputfile, 0);
        }, 50);
    }
    else {
        alert("Please select a valid AGP file to load.");
    }
}

/* Given a line of text (i.e. no newline characters are in the line), adds the
 * contig referenced in that line to the SCAFFOLDID2NODEKEYS mapping. Also
 * adds the scaffold referenced in that line, if not already defined (i.e. this
 * is the first line we've called this function on that references that
 * scaffold).
 *
 * Saves contig/scaffold info for the entire assembly graph, not just the
 * current connected component. This will allow us to reuse the same mapping
 * for multiple connected components' visualizations.
 *
 * If there's an error in reading the given line's text, returns a nonzero
 * value. This should be used to halt processing of this AGP file in
 * loadAGPfile(). Otherwise, returns 0.
 */
function integrateAGPline(lineText) {
    // Avoid processing empty lines (e.g. due to trailing newlines in files)
    // Also avoid processing comment lines (lines that start with #)
    if (lineText != "" && lineText[0] !== "#") {
        var lineColumns = lineText.split("\t");
        var scaffoldID = lineColumns[0];
        var contigKey = lineColumns[5];
        if (contigKey === undefined) {
            alert("Invalid line in input AGP file: \n" + lineText);
            return -1;
        }
        // If the node ID has metadata, truncate it
        if (contigKey.startsWith("NODE")) {
            contigKey = "NODE_" + contigKey.split("_")[1];
        }
        // Save scaffold node composition data for all scaffolds, not just
        // scaffolds pertinent to the current connected component
        if (SCAFFOLDID2NODEKEYS[scaffoldID] === undefined) {
            SCAFFOLDID2NODEKEYS[scaffoldID] = [contigKey];
            // Check if this contig is in the current connected component and,
            // if so, add a list group item for its scaffold (since this is the
            // first time we're seeing this scaffold).
            // (We use COMPONENT_NODE_KEYS for this because running
            // cy.filter() repeatedly can get really slow.)
            if (COMPONENT_NODE_KEYS.indexOf(contigKey) !== -1) {
                addScaffoldListGroupItem(scaffoldID);
            }
        }
        else {
            SCAFFOLDID2NODEKEYS[scaffoldID].push(contigKey);
        }
    }
    return 0;
}

/* Creates a list group item for a scaffold with the given ID.
 * (The ID should match up with a key in SCAFFOLDID2NODEKEYS.)
 */
function addScaffoldListGroupItem(scaffoldID) {
    if (!COMPONENT_HAS_SCAFFOLDS) {
        COMPONENT_HAS_SCAFFOLDS = true;
        COMPONENT_SCAFFOLDS = [];
        $("#drawScaffoldButton").text(scaffoldID);
        SCAFFOLD_CYCLER_CURR_INDEX = 0;
        $("#scaffoldCycler").removeClass("notviewable");
    }
    COMPONENT_SCAFFOLDS.push(scaffoldID);
}

/* Identifies scaffolds located in the current connected component (using the
 * keys to SCAFFOLDID2NODEKEYS as a list of scaffolds to try) and, for those
 * scaffolds, calls addScaffoldListGroupItem().
 */
function updateScaffoldsInComponentList() {
    for (var s in SCAFFOLDID2NODEKEYS) {
        // All nodes within a (valid) scaffold are in the same connected
        // component, so we can just use the first node in a scaffold as an
        // indicator for whether or not that scaffold is in the current
        // connected component.
        // (This is pretty much the same way we do this when initially loading
        // scaffold data, as with integrateAGPline() above.)
        if (COMPONENT_NODE_KEYS.indexOf(SCAFFOLDID2NODEKEYS[s][0]) !== -1){
            addScaffoldListGroupItem(s);
        }
    }
    updateScaffoldInfoHeader(false);
}

/* Recursively loads the AGP file using Blobs. (After the FileReader loads a
 * Blob, it calls this method for the next Blob.)
 *
 * fileReader and file should remain constant through the recursive loading
 * process, while filePosition will be updated as the file is loaded.
 * The initial call to loadAGPfile() should use filePosition = 0 (in order to
 * start reading the file from its 0th byte, i.e. its beginning).
 */
function loadAGPfile(fileReader, file, filePosition) {
    // Only get a Blob if it'd have some data in it
    if (filePosition <= file.size) {
        // In interval notation, the slice includes bytes in the range
        // [filePosition, endPosition). That is, the endPosition byte is not
        // included in currentBlob.
        var endPosition = filePosition + BLOB_SIZE;
        var currentBlob = file.slice(filePosition, endPosition);
        if (endPosition > file.size) {
            fileReader.readingFinalBlob = true;
        }
        fileReader.nextStartPosition = endPosition;
        fileReader.readAsText(currentBlob);
    }
    else {
        updateScaffoldInfoHeader(true);
    }
}

/* Updates scaffoldInfoHeader depending on whether or not scaffolds were
 * identified in the current connected component.
 *
 * If agpFileJustLoaded is true, then the agpLoadedFileName will be updated,
 * scaffoldFileSelector will have its value cleared (to allow for the same
 * AGP file to be loaded again if necessary) finishProgressBar() will be
 * called. Therefore, agpFileJustLoaded should only be set to true when this
 * function is being called after an AGP file has just been loaded.
 */
function updateScaffoldInfoHeader(agpFileJustLoaded) {
    if (COMPONENT_HAS_SCAFFOLDS) {
        $("#scaffoldInfoHeader").html("Scaffolds in Connected Component<br/>" +
            "(Click to highlight in graph)");
    }
    else {
        $("#scaffoldInfoHeader").html("No scaffolds apply to the contigs " +
            "in this connected component.");
    }
    $("#scaffoldInfoHeader").removeClass("notviewable");
    // Perform a few useful operations if the user just loaded this AGP file.
    // These operations are not useful, however, if the AGP file has already
    // been loaded and we just ran updateScaffoldsInComponentList().
    if (agpFileJustLoaded) {
        $("#agpLoadedFileName").html(
            document.getElementById("scaffoldFileSelector").files[0].name);
        $("#agpLoadedFileName").removeClass("notviewable");
        clearScaffoldFS(false);
    }
}

/* Clears the scaffold file selector's value attribute and calls
 * finishProgressBar().
 * If errorOnAGPload is true, then this:
 *  -clears SCAFFOLDID2NODEKEYS,
 *  -sets COMPONENT_HAS_SCAFFOLDS to false,
 *  -clears COMPONENT_SCAFFOLDS,
 *  -Adds the "notviewable" class to #scaffoldCycler
 */
function clearScaffoldFS(errorOnAGPload) {
    if (errorOnAGPload) {
        SCAFFOLDID2NODEKEYS = {};
        COMPONENT_HAS_SCAFFOLDS = false;
        COMPONENT_SCAFFOLDS = [];
        $("#scaffoldCycler").addClass("notviewable");
    }
    document.getElementById('scaffoldFileSelector').value = "";
    finishProgressBar();
}

function cycleScaffoldsLeft() {
    if (SCAFFOLD_CYCLER_CURR_INDEX === 0) {
        SCAFFOLD_CYCLER_CURR_INDEX = COMPONENT_SCAFFOLDS.length - 1;
    } else {
        SCAFFOLD_CYCLER_CURR_INDEX--;
    }
    updateDrawScaffoldButtonText();
}

function cycleScaffoldsRight() {
    if (SCAFFOLD_CYCLER_CURR_INDEX === COMPONENT_SCAFFOLDS.length - 1) {
        SCAFFOLD_CYCLER_CURR_INDEX = 0;
    } else {
        SCAFFOLD_CYCLER_CURR_INDEX++;
    }
    updateDrawScaffoldButtonText();
}

// Also highlights the new scaffold.
function updateDrawScaffoldButtonText() {
    var newScaffoldID = COMPONENT_SCAFFOLDS[SCAFFOLD_CYCLER_CURR_INDEX];
    $("#drawScaffoldButton").text(newScaffoldID);
    highlightScaffold(newScaffoldID);
}

/* Highlights the contigs within a scaffold by selecting them.
 * This assumes that the passed ID is valid. If it isn't valid (i.e. no
 * scaffold with that ID exists in the currently loaded AGP file) then this
 * will result in an error.
 */
function highlightScaffold(scaffoldID) {
    // TODO can make this more efficient -- see #115, etc.
    cy.filter(':selected').unselect();
    var contigKeys = SCAFFOLDID2NODEKEYS[scaffoldID];
    var nodesToHighlight = cy.collection();
    var nodeToAdd;
    var prefix;
    for (var i = 0; i < contigKeys.length; i++) {
        if (ASM_FILETYPE === "GML") {
            // Figure out if we need to use cy.getElementById (if this scaffold
            // refers to a node group) instead of filtering by label
            prefix = contigKeys[i][0];
            if (prefix === 'B' || prefix === 'F' || prefix === 'C'
                    || prefix === 'Y') {
                nodeToAdd = cy.getElementById(contigKeys[i]);
            }
            else {
                nodeToAdd = cy.filter("[label=\"" + contigKeys[i] + "\"]");
            }
        }
        else {
            nodeToAdd = cy.getElementById(contigKeys[i]);
        }
        if (nodeToAdd.empty()) {
            // The node could still be contained within a collapsed node group.
            // In that case, we'd highlight the node group in question.
            nodeToAdd = cy.getElementById(
                cy.scratch("_ele2parent")[contigKeys[i]]
            );
            if (nodeToAdd.empty()) {
                // If we've reached this point in the code, the node is not
                // contained within the current connected component at all.
                // Throw an error (since this scaffold was supposed to only
                // describe nodes in the current connected component).
                var keyType = "ID ";
                if (ASM_FILETYPE === "GML") {
                    keyType = "label ";
                }
                alert("Node with " + keyType + contigKeys[i] +
                      " in scaffold \"" + scaffoldID + "\"" +
                      " is not present in the currently drawn connected" +
                      " component. This scaffold is invalid.");
                return;
            }
        }
        nodesToHighlight = nodesToHighlight.union(nodeToAdd);
    }
    nodesToHighlight.select();
}

function addNodeFromEventToPath(e) {
    var node = e.target;
    // TODO: add a status update <div> or something in the ctrl panel
    // TODO don't select the last node on the path automatically, as seems to
    // happen now (?) -- look at the code, see if anything looks weird/is
    // causing that
    // TODO: make autofinishing work when first node clicked in finishing has
    // unambiguous outgoing edge
    // TODO: make autofinishing stop when it gets to linear cycles
    // Options:
    //  -Traverse entire linear cycle once and then provide option to users to
    //   traverse it again
    //  -Just stop autofinishing as soon as a node is identified in a linear
    //   cycle
    var justStartedLinearCycleFinishing = false;
    var justAddedCollapsedCyclicChain = false;
    if (!(node.hasClass("cluster") && !node.data("isCollapsed"))) {
        // Don't add uncollapsed clusters, but allow collapsed clusters to be
        // added
        var nodeID = node.id();
        justAddedCollapsedCyclicChain = node.hasClass("Y");
        if (FINISHING_NODE_IDS.length > 0) {
            if (NEXT_NODES.is("#" + nodeID)) {
                cy.startBatch();
                NEXT_NODES.removeClass("tentative");
                cy.endBatch();
                NEXT_NODES = node.outgoers("node");
                if (justAddedCollapsedCyclicChain) {
                    NEXT_NODES = NEXT_NODES.union(node);
                }
                var size = NEXT_NODES.size();
                //if (!FINISHING_LINEAR_CYCLE && size === 1) {
                //    var autofinishingSeenNodeIDs = [];
                //    while (size === 1) {
                //        if (autofinishingSeenNodeIDs.indexOf(nodeID) !== -1){
                //            FINISHING_LINEAR_CYCLE = true;
                //            justStartedLinearCycleFinishing = true;
                //            break;
                //        }
                //        $("#assembledNodes").append(", " + nodeID);
                //        FINISHING_NODE_IDS += "," + nodeID;
                //        autofinishingSeenNodeIDs.push(nodeID);
                //        node = NEXT_NODES[0];
                //        nodeID = node.id();
                //        NEXT_NODES = node.outgoers("node");
                //        size = NEXT_NODES.size();
                //    }
                //}
                // TODO add something that keeps track of previous node and
                // removes this class from it
                // don't use cy.js to do a filter, just cache the ID or
                // something to be more efficient
                //node.addClass("tentativedock");
                if (size === 0) {
                    endFinishing();
                }
                else { // includes case where FINISHING_LINEAR_CYCLE is true
                    cy.startBatch();
                    NEXT_NODES.addClass("tentative");
                    cy.endBatch();
                }
                $("#assembledNodes").append(", " + nodeID);
                FINISHING_NODE_IDS += "," + nodeID;
                FINISHING_NODE_OBJS.push(node);
            }
            else {
                return;
            }
        }
        else {
            // TODO abstract repeated code to a function
            NEXT_NODES = node.outgoers("node");
            if (justAddedCollapsedCyclicChain) {
                NEXT_NODES = NEXT_NODES.union(node);
            }
            var size = NEXT_NODES.size();
            if (size === 0) {
                $("#assembledNodes").append(nodeID);
                FINISHING_NODE_IDS += nodeID;
                FINISHING_NODE_OBJS.push(node);
                endFinishing();
                return;
            }
            cy.startBatch();
            NEXT_NODES.addClass("tentative");
            cy.endBatch();
            $("#assembledNodes").append(nodeID);
            FINISHING_NODE_IDS += nodeID;
            FINISHING_NODE_OBJS.push(node);
        }
    }
}

function startFinishing() {
    if (!FINISHING_MODE_ON) {
        disableButton("startFinishingButton");
        if (FINISHING_MODE_PREVIOUSLY_DONE) {
            FINISHING_NODE_IDS = "";
            FINISHING_NODE_OBJS = [];
            $("#assembledNodes").empty();
            disableButton("exportPathButton");
        }
        FINISHING_MODE_ON = true;
        // TODO can make this more efficient -- see #115, etc.
        cy.filter(':selected').unselect();
        cy.autounselectify(true);
        cy.on("tap", "node", addNodeFromEventToPath);
    }
    enableButton("endFinishingButton");
}

function endFinishing() {
    FINISHING_MODE_ON = false;
    FINISHING_MODE_PREVIOUSLY_DONE = true;
    FINISHING_LINEAR_CYCLE = false;
    cy.startBatch();
    NEXT_NODES.removeClass("tentative");
    cy.endBatch();
    NEXT_NODES = cy.collection();
    cy.autounselectify(false);
    cy.off("tap");
    enableButton("exportPathButton");
    enableButton("startFinishingButton");
    disableButton("endFinishingButton");
}

function exportPath() {
    var exportFileType = $("#pathExportButtonGroup .btn.active").attr("value");
    var textToExport = "";
    if (exportFileType === "AGP") {
        // export AGP
        var nextStartPos = 1;
        var nextEndPos;
        var nodeLen, nodeOrient, nodeKey;
        var componentType;
        for (var i = 0; i < FINISHING_NODE_OBJS.length; i++) {
            nodeLen = FINISHING_NODE_OBJS[i].data("length");
            // NOTE that we assume that nodes with the "rightdir" class must
            // all have a forward orientation. If dynamic graph rotation
            // gets added back in, that will break this.
            // (In that case, the ideal solution would be to just give
            // forward-oriented nodes a "is_fwd" data() attribute or
            // something.)
            componentType = "W"; // for "WGS contig"
            if (FINISHING_NODE_OBJS[i].hasClass("cluster")) {
                nodeOrient = "na";
                componentType = "O"; // for "Other sequence"
            }
            else if (FINISHING_NODE_OBJS[i].hasClass("rightdir")) {
                nodeOrient = "+";
            }
            else {
                nodeOrient = "-";
            }
            // Since node groups and nodes from non-GML inputs don't have
            // label data, use these objects' IDs instead.
            if (componentType === "W" && ASM_FILETYPE === "GML") {
                nodeKey = FINISHING_NODE_OBJS[i].data("label");
            }
            else {
                nodeKey = FINISHING_NODE_OBJS[i].id();
            }
            // Add a line for this node
            nextEndPos = (nextStartPos - 1) + nodeLen;
            textToExport += "scaffold_1\t" + nextStartPos + "\t" + nextEndPos +
                "\t" + i + "\t" + componentType + "\t" + nodeKey + "\t1\t" +
                nodeLen + "\t" + nodeOrient + "\n";
            nextStartPos = nextEndPos + 1;
        }
        downloadDataURI("path.agp", textToExport, true);
    }
    else {
        // export CSV
        textToExport = FINISHING_NODE_IDS;
        downloadDataURI("path.csv", textToExport, true);
    }
}

function startChangeNodeColorization() {
    var newColorization = $("#nodeColorizationRadioButtonGroup input:checked")
        .attr("value");
    // We check to ensure the new colorization would be different from the
    // current one -- if not, we don't bother doing anything
    if (newColorization !== CURR_NODE_COLORIZATION) {
        startIndeterminateProgressBar();
        window.setTimeout(function() {
            changeNodeColorization(newColorization);
            finishProgressBar();
        }, 50);
    }
}

function changeNodeColorization(newColorization) {
    cy.startBatch();
    cy.filter('node.noncluster')
        .removeClass(CURR_NODE_COLORIZATION)
        .addClass(newColorization);
    // Make sure to apply the colorization to collapsed nodes, also!
    cy.scratch("_collapsed").each(function(nodeGroup, i) {
        nodeGroup.scratch("_interiorNodes")
            .removeClass(CURR_NODE_COLORIZATION)
            .addClass(newColorization);
    });
    CURR_NODE_COLORIZATION = newColorization;
    cy.endBatch();
}

/* Returns a #RRGGBB string indicating the color of a node, scaled by a
 * percentage (some value in the range [0, 1]).
 */
function getNodeColorization(gc) {
    var percentageUsedInColorization = gc;
    //// Discrete colorization, where ranges of size percentageBin are colorized
    //// equally. So if p = 100 / percentageBin, then percentage ranges of
    //// [0, p), [p, 2p), [2p, 3p), ... will all be colorized equally.
    //// TODO make percentageBin a user-configurable thing, if we incorporate
    //// this feature into the tool
    //// Also I think percentageBin might only make sense as an integer, due to
    //// our use of modulus? Not sure, though.
    //var percentageBin = 30;
    //var t;
    //// NOTE that there's the potential for some weirdness here due to our use
    //// of Math.floor() in computing "bins." If 100 is divisible by
    //// percentageBin then there will actually be an extra "bin" created for
    //// the case where gc = 1 -- this is expected. If we used Math.ceil()
    //// instead, we'd similarly have an extra bin created for the case where
    //// gc = 0. To rectify this we just merge the extra bin with the bin below
    //// it.
    //// That being said, this has the effect of making the "max" color (#FF2200)
    //// not actually used in these cases. It'd be worth taking some time
    //// to fix that (i.e. making it so that the "penultimate" bin is treated as
    //// if it corresponds to 100%, and the intermediate colors are adjusted
    //// accordingly) -- not exactly sure how to go about doing that.
    //if (gc === 1 && (100 % percentageBin === 0)) {
    //    t = (100 / percentageBin) - 1;
    //}
    //else {
    //    // t is the lower value of the "range" into which the specified
    //    // GC-content is placed. For example, if percentageBin = 10% then the
    //    // t-value of 3.1% would be 0 and the t-value of 25% would be 3. 
    //    t = Math.floor((gc * 100) / percentageBin);
    //}
    //percentageUsedInColorization = ((t * percentageBin) / 100);
    //
    // Everything from here on down is normal continuous colorization.
    // Linearly scale each RGB value between the extreme colors'
    // corresponding RGB values
    var red_i = (gc * (MAX_RGB['r'] - MIN_RGB['r'])) + MIN_RGB['r'];
    var green_i = (gc * (MAX_RGB['g'] - MIN_RGB['g'])) + MIN_RGB['g'];
    var blue_i = (gc * (MAX_RGB['b'] - MIN_RGB['b'])) + MIN_RGB['b'];
    // Convert resulting RGB decimal values (should be in the range [0, 255])
    // to hexadecimal and use them to construct a color string
    var red = Math.round(red_i).toString(16);
    var green = Math.round(green_i).toString(16);
    var blue = Math.round(blue_i).toString(16);
    // Ensure that the color string is 6 characters long (for single-digit
    // channel values, we need to pad on the left with a zero)
    var channels = [red, green, blue];
    for (var ch = 0; ch < 3; ch++) {
        if (channels[ch].length === 1) {
            channels[ch] = "0" + channels[ch];
        }
    }
    return "#" + channels[0] + channels[1] + channels[2];
}

/* Redraws the gradient preview for node colorization.
 * If minOrMax is -1, then we use hexColor as the new minimum color.
 * Otherwise, we use hexColor as the new maximum color.
 */
function redrawGradientPreview(hexColor, minOrMax) {
    var tmpColor;
    if (minOrMax === -1) {
        $("#0gp").css("background-color", hexColor);
        MIN_RGB = $("#mincncp").data("colorpicker").color.toRGB();
        MIN_HEX = hexColor;
        if (MAX_RGB === undefined) {
            tmpColor = $("#maxcncp").data("colorpicker").color;
            MAX_RGB = tmpColor.toRGB();
            MAX_HEX = tmpColor.toHex();
        }
    }
    else {
        $("#100gp").css("background-color", hexColor);
        MAX_RGB = $("#maxcncp").data("colorpicker").color.toRGB();
        MAX_HEX = hexColor;
        if (MIN_RGB === undefined) {
            tmpColor = $("#mincncp").data("colorpicker").color;
            MIN_RGB = tmpColor.toRGB();
            MIN_HEX = tmpColor.toHex();
        }
    }
    // Change intermediate colors in the gradient
    $("#25gp").css("background-color", getNodeColorization(0.25));
    $("#50gp").css("background-color", getNodeColorization(0.50));
    $("#75gp").css("background-color", getNodeColorization(0.75));
}

// Like searchWithEnter() but for testLayout()
function layoutWithEnter(e) {
    if (e.charCode === 13) {
        testLayout();
    }
}

// Allows user to test one of Cytoscape.js' predefined layouts
function testLayout() {
    if ($("#layoutInput").val() !== "") {
        startIndeterminateProgressBar();
        cy.minZoom(0);
        window.setTimeout(function() {
            // Change to simple bezier edges, since node placement
            // will be changed
            // Adjust min zoom to scope of new layout
            reduceEdgesToStraightLines(false);
            cy.layout({name: $("#layoutInput").val(), fit: true, padding: 0,
                stop: function() {
                    finishProgressBar();
                }
            }).run();
        }, 20);
    }
}

/* Reduces all unbundledbezier edges to basicbezier edges.
 * I guess it'd be nice to eventually add in support to revert these edges to
 * their unbundledbezier forms, but that might require some extra logic
 * (due to collapsing/uncollapsing -- similar to the issues we ran into with
 * hiding/unhiding edges below/above a certain multiplicity).
 *
 * If useProgressBar is true, then an indeterminate progress bar will be
 * started and finished before/after reducing all edges. If useProgressBar is
 * false, then the progress bar will not be triggered.
 */
function reduceEdgesToStraightLines(useProgressBar) {
    if (useProgressBar) {
        startIndeterminateProgressBar();
        window.setTimeout(function() {
            doReduceEdges();
            finishProgressBar();
        }, 50);
    }
    else {
        doReduceEdges();
    }
}

/* Actually does the work of reducing edges. */
function doReduceEdges() {
    cy.startBatch();
    cy.filter("edge").each(
        function(e, i) {
            // We can safely use this even for non-unbundledbezier edges.
            // The reason we don't restrict this loop to unbundledbezier
            // edges is that we want to apply this even to unbundledbezier
            // edges that have been temporarily reduced to basicbezier
            // edges due to node group collapsing.
            e.removeClass("unbundledbezier");
            e.addClass("reducededge");
            e.addClass("basicbezier");
        }
    );
    cy.endBatch();
}

// Simple shortcut used to enable searching by pressing Enter (charCode 13)
function searchWithEnter(e) {
    if (e.charCode === 13) {
        searchForEles();
    }
}

// Centers the graph on a given list of elements separated by commas, with
// spaces optional.
// If any terms entered start with "contig" or "NODE", then this searches on
// node labels for those terms.
function searchForEles() {
    var nameText = $("#searchInput").val();
    if (nameText.trim() === "") {
        alert("Error -- please enter element name(s) to search for.");
        return;
    }
    var names = nameText.split(",")
    var eles = cy.collection(); // empty collection (for now)
    var newEle;
    var parentID;
    var queriedName;
    for (var c = 0; c < names.length; c++) {
        queriedName = names[c].trim();
        if (queriedName.startsWith("contig") || queriedName.startsWith("NODE"))
            newEle = cy.filter("[label=\"" + queriedName + "\"]");
        else
            newEle = cy.getElementById(queriedName);
        if (newEle.empty()) {
            // Check if this element is in the graph (but currently
            // collapsed, and therefore inaccessible) or if it just
            // never existed in the first place
            parentID = cy.scratch("_ele2parent")[queriedName];
            if (parentID !== undefined) {
                // We've collapsed the parent of this element, so identify
                // its parent instead
                eles = eles.union(cy.getElementById(parentID));
            }
            else {
                // It's a bogus element
                alert("Error -- element ID/label " + queriedName +
                      " is not in this component.");
                return;
            }
        }
        else {
            // Identify the node in question
            eles = eles.union(newEle);
        }
    }
    // Fit the graph to the identified names.
    cy.fit(eles);
    // Unselect all previously-selected names
    // (TODO: is this O(n)? because if so, it's not worth it, probably)
    // (Look into this)
    // TODO can make this more efficient -- see #115, etc.
    cy.filter(':selected').unselect();
    // Select all identified names, so they can be dragged if desired
    // (and also to highlight them).
    eles.select();
}

/* In explicit mode, reveals the descendant metanodes (and their skeletons) of
 * the passed metanode.
 *
 * In implicit mode, adds the real edges and new singlenodes of the skeletons
 * of the descendant metanodes to the skeleton of the current metanode.
 *
 * (This function should only be called if the metanode in question has
 * immediate descendants and is currently collapsed.)
 */
function uncollapseSPQRMetanode(mn) {
    var mnID = mn.id();
    // 1. Get outgoing edges from this metanode
    var outgoingEdgesStmt = CURR_DB.prepare(
        "SELECT * FROM metanodeedges WHERE source_metanode_id = ?", [mnID]);
    var outgoingEdgeObjects = [];
    var descendantMetanodeIDs = [];
    var descendantMetanodeQMs = "("; // this is a bit silly
    var edgeObj;
    while (outgoingEdgesStmt.step()) {
        edgeObj = outgoingEdgesStmt.getAsObject();
        outgoingEdgeObjects.push(edgeObj);
        descendantMetanodeIDs.push(edgeObj["target_metanode_id"]);
        descendantMetanodeQMs += "?,"
    }
    outgoingEdgesStmt.free();
    // For future use, when re-collapsing this metanode
    mn.scratch("_descendantMetanodeIDs", descendantMetanodeIDs);
    // 2. Get immediate descendant metanodes
    descendantMetanodeQMs = descendantMetanodeQMs.slice(0,
        descendantMetanodeQMs.length - 1) + ")";
    var descendantMetanodesStmt = CURR_DB.prepare(
        "SELECT * FROM metanodes WHERE metanode_id IN "
      + descendantMetanodeQMs, descendantMetanodeIDs);
    var descendantMetanodeObjects = [];
    while (descendantMetanodesStmt.step()) {
        descendantMetanodeObjects.push(descendantMetanodesStmt.getAsObject());
    }
    descendantMetanodesStmt.free();
    // 3. Get singlenodes contained within the skeletons of the descendants
    var singlenodesStmt = CURR_DB.prepare(
        "SELECT * FROM singlenodes WHERE parent_metanode_id IN"
      + descendantMetanodeQMs, descendantMetanodeIDs);
    var singlenodeObjects = [];
    while (singlenodesStmt.step()) {
        singlenodeObjects.push(singlenodesStmt.getAsObject());
    }
    singlenodesStmt.free();
    // 4. Get singleedges contained within the skeletons of the descendants
    var singleedgesStmt = CURR_DB.prepare(
        "SELECT * FROM singleedges WHERE parent_metanode_id IN"
      + descendantMetanodeQMs, descendantMetanodeIDs);
    var singleedgeObjects = [];
    while (singleedgesStmt.step()) {
        singleedgeObjects.push(singleedgesStmt.getAsObject());
    }
    singleedgesStmt.free();
    // At this point, we have all the new elements ready to draw.
    // So draw them!
    var a, b;
    // We prepare this mapping to pass it to renderEdgeObject()
    // It's used in control point calculations for unbundled-bezier edges,
    // which metanodeedges are currently rendered as.
    var sourcePos = mn.position();
    var descendantID2pos = {};
    descendantID2pos[mnID] = [sourcePos['x'], sourcePos['y']];
    var clusterIDandPos = [];
    for (a = 0; a < descendantMetanodeObjects.length; a++) {
        if (CURR_SPQRMODE === "explicit" ||
                descendantMetanodeObjects[a]['descendant_metanode_count'] > 0){
            clusterIDandPos = renderClusterObject(descendantMetanodeObjects[a],
                CURR_BOUNDINGBOX, "metanode");
            descendantID2pos[clusterIDandPos[0]] = clusterIDandPos[1];
        }
    }
    if (CURR_SPQRMODE === "explicit") {
        for (a = 0; a < outgoingEdgeObjects.length; a++) {
            renderEdgeObject(outgoingEdgeObjects[a], descendantID2pos,
                    CURR_BOUNDINGBOX, "metanodeedge", "SPQR", {});
        }
    }
    var cyNodeID, normalID, parentBicmpID;
    var currIDs;
    var alreadyVisible;
    var singlenodeMapping = {};
    for (a = 0; a < singlenodeObjects.length; a++) {
        normalID = singlenodeObjects[a]['id'];
        // In implicit mode, only render a new singlenode if it isn't already
        // visible in the parent bicomponent
        if (CURR_SPQRMODE === "implicit") {
            parentBicmpID = singlenodeObjects[a]['parent_bicomponent_id'];
            currIDs = BICOMPONENTID2VISIBLESINGLENODEIDS[parentBicmpID];
            alreadyVisible = false;
            for (b = 0; b < currIDs.length; b++) {
                if (normalID === currIDs[b].split("_")[0]) {
                    alreadyVisible = true;
                    singlenodeMapping[normalID] = currIDs[b];
                    break;
                }
            }
            if (alreadyVisible) {
                continue;
            }
        }
        cyNodeID = normalID + "_"
                + singlenodeObjects[a]['parent_metanode_id'];
        renderNodeObject(singlenodeObjects[a], cyNodeID, CURR_BOUNDINGBOX,
                "SPQR");
    }
    for (a = 0; a < singleedgeObjects.length; a++) {
        renderEdgeObject(singleedgeObjects[a], {},
            CURR_BOUNDINGBOX, "singleedge", "SPQR", singlenodeMapping);
    }
    if (CURR_SPQRMODE === "explicit") {
        mn.data("isCollapsed", false);
    }
    else {
        var edgesToRemove = mn.scratch("_virtualedgeIDs");
        var edgeToRemove;
        for (var c = 0; c < edgesToRemove.length; c++) {
            edgeToRemove = cy.getElementById(edgesToRemove[c]);
            edgeToRemove.unselect();
            edgeToRemove.remove();
        }
        mn.unselect();
        mn.remove();
    }
}

/* Removes the descendant metanodes of the passed metanode from the display.
 *
 * (This function should only be called if the metanode in question has
 * immediate descendants and is currently uncollapsed.)
 */
function collapseSPQRMetanode(mn) {
    var a, b;
    var descendantMetanodeIDs = mn.scratch("_descendantMetanodeIDs");
    var mn2;
    var singlenodeIDs;
    for (a = 0; a < descendantMetanodeIDs.length; a++) {
        mn2 = cy.getElementById(descendantMetanodeIDs[a]);
        if (mn2.data("descendantCount") > 0 && !(mn2.data("isCollapsed"))) {
            // We have to recursively collapse mn2
            collapseSPQRMetanode(mn2);
        }
        // Now, we remove the contents of mn2
        singlenodeIDs = mn2.scratch("_singlenodeIDs");
        var nodeToRemove;
        for (b = 0; b < singlenodeIDs.length; b++) {
            // Calling cy.remove() on a node also removes the edges incident
            // upon it, so we don't need to worry about explicitly removing
            // the singleedges contained in the skeleton of mn2
            nodeToRemove = cy.getElementById(singlenodeIDs[b]);
            nodeToRemove.unselect();
            // This isn't actually that bad performance-wise -- it's still
            // linear in the number of edges to be removed. Since (as noted
            // above) edges are automatically removed when a node they're
            // incident on is removed, edges we've previously unselected won't
            // be returned in future connectedEdges() calls. So the only
            // inefficiency here is on calling connectedEdges() on nodes where
            // there will potentially be no incident edges, but I doubt that'll
            // have a significant impact on the performance of the application.
            nodeToRemove.connectedEdges().unselect();
            nodeToRemove.remove();
        }
        // Now we can remove mn2 itself
        mn2.unselect();
        mn2.remove();
    }
    mn.data("isCollapsed", true);
}

/* Determines whether collapsing or uncollapsing should be performed,
 * updates the status div accordingly, and begins the (un)collasping
 * process.
 */
function startCollapseAll() {
    if (CURR_VIEWTYPE !== "SPQR") {
        var currVal = $("#collapseButtonText").text();
        startIndeterminateProgressBar();
        window.setTimeout(function() { collapseAll(currVal[0]) }, 50);
    }
}

/* Collapse/uncollapse all compound nodes in the graph.
 * This just delegates to collapseCluster() and uncollapseCluster().
 * An argument of 'U' uncollapses all nodes, and an argument of 'C' (or
 * anything that isn't 'U') collapses all nodes.
 */
function collapseAll(operationCharacter) { 
    cy.startBatch();
    if (operationCharacter === 'U') {
        cy.scratch("_collapsed").each(
            function(cluster, i) {
                uncollapseCluster(cluster);
            }
        );
    }
    else {
        cy.scratch("_uncollapsed").each(
            function(cluster, i) {
                collapseCluster(cluster);
            }
        );
    }
    finishProgressBar();
    cy.endBatch();
}

// Converts an angle in degrees to radians (for use with Javascript's trig
// functions)
function degreesToRadians(angle) {
    return angle * (Math.PI / 180);
}

// Rotates a coordinate by a given clockwise angle (in degrees).
// Returns an array of [x', y'] representing the new point.
function rotateCoordinate(xCoord, yCoord) {
    // NOTE The formula for a coordinate transformation here works for all
    // degree inputs of rotation. However, to save time, we just check
    // to see if the rotation is a factor of 360 (i.e. the rotated
    // point would be the same as the initial point), and if so we just
    // return the original coordinates.
    var rotation = PREV_ROTATION - CURR_ROTATION;
    if (rotation % 360 === 0) {
        return [xCoord, yCoord];
    }
    else {
        var newX = (xCoord * Math.cos(degreesToRadians(rotation)))
                    - (yCoord * Math.sin(degreesToRadians(rotation)));
        var newY = (yCoord * Math.cos(degreesToRadians(rotation)))
                    + (xCoord * Math.sin(degreesToRadians(rotation)));
        newX = parseFloat(newX.toFixed(2));
        newY = parseFloat(newY.toFixed(2));
        return [newX, newY];
    }
}

/* Given the bounding box of the graph, a graph rotation angle (in degrees),
 * and a point specified by x and y coordinates, converts the point from
 * GraphViz' coordinate system to Cytoscape.js' coordinate system, rotating
 * the point if necessary (i.e. the rotation angle mod 360 !== 0).
 *
 * For reference -- GraphViz uses the standard Cartesian system in which
 * the bottom-left corner of the screen is the origin, (0, 0). Cytoscape.js
 * inverts the y-axis, with the origin (0, 0) being situated at the
 * top-right corner of the screen. So to transform a point (x, y) from
 * GraphViz to Cytoscape.js, you just return (x, y'), where
 * y' = the vertical length of the bounding box, minus y.
 * (The x-coordinate remains the same.)
 *
 * This is a purposely simple function -- in the event that we decide to
 * use another graphing library/layout system/etc. for some reason, we can
 * just modify this function accordingly.
 */
function gv2cyPoint(xCoord, yCoord, boundingbox) {
    // Convert from GraphViz to Cytoscape.js
    var cyY = boundingbox[1] - yCoord;
    var cyX = xCoord;
    // Rotate the point about the axis if necessary
    return rotateCoordinate(cyX, cyY);
}

/* Converts a string of control points (defined in the form "x1 y1 x2 y2",
 * for an arbitrary number of points) to a 2-dimensional list of floats,
 * of the form [[x1, y1], [x2, y2], ...]. If the input string contains an
 * odd number of coordinate components for some reason (e.g.
 * "x1 y1 x2 y2 x3") then this will return null, since that's invalid.
 * This also takes care of converting each point in the input string from
 * GraphViz' coordinate system to Cytoscape.js' coordinate system.
 * (Hence why the graph's bounding box and rotation are parameters here.)
 */
function ctrlPtStrToList(ctrlPointStr, boundingbox) {
    // Create coordList, where every coordinate is an element (e.g.
    // [x1, y1, x2, y2, ...]
    var coordList = ctrlPointStr.trim().split(" ");
    // Merge two elements of coordList at a time. NOTE that this is only
    // possible when coordList.length is even, so this is why we have to
    // wait until we're finished parsing all control points until doing
    // this conversion. (If coordList.length is odd, return null --
    // something went very wrong in that case.)
    var clLen = coordList.length;
    if (clLen % 2 !== 0) {
        return null;
    }
    else {
        var pointList = [];
        var currPoint = [];
        for (var i = 0; i < clLen; i++) {
            if (i % 2 === 0) {
                // i/2 is always an integer, since i is even
                pointList[i / 2] = gv2cyPoint(
                        parseFloat(coordList[i]),
                        parseFloat(coordList[i + 1]),
                        boundingbox
                );
            }
        }
        return pointList;
    }
}

/* NOTE -- this is an unused function right now. Could be useful in the future,
 * perhaps.
 * Initializes the adjacent edges (i.e. incoming + outgoing edges) of
 * every non-cluster node in the graph. This would be useful if we
 * enabled dynamic edge validity checking (it makes checking each node's
 * edges more efficient, since we only have to build up these collections
 * once), but for now dynamic edge validity checking is disabled due to
 * still being too slow.
 */
function initNodeAdjacents() {
    cy.filter('node.noncluster').each(
        function(node, i) {
            node.data("adjacentEdges",
                node.incomers('edge').union(node.outgoers('edge'))
            );
        }
    );
}

// Records actual and canonical incoming/outgoing edges of clusters in the
// data of the cluster, as incomingEdges and outgoingEdges (actual
// edges in the graph) and cSource and cTarget (canonical source/target).
// This is going to involve iterating over every compound node in the graph.
// See collapse() for guidance on how to do that, I guess.
// NOTE that we delay doing this work until after everything else has been
// rendered in order to ensure that all edges/nodes necessary for this have
// already been rendered.
function initClusters() {
    // For each compound node...
    cy.scratch("_uncollapsed").each(
        function(node, i) {
            var children = node.children();        
            // Unfiltered incoming/outgoing edges
            var uIncomingEdges = children.incomers('edge');
            var uOutgoingEdges = children.outgoers('edge');
            // Actual incoming/outgoing edges -- will be move()'d as
            // this cluster/adjacent cluster(s) are collapsed/uncollapsed
            var incomingEdges  = uIncomingEdges.difference(uOutgoingEdges);
            var outgoingEdges  = uOutgoingEdges.difference(uIncomingEdges);
            // Mapping of edge ID to [cSource, cTarget]
            // Used since move() removes references to edges, so storing IDs
            // is more permanent
            var incomingEdgeMap = {};
            var outgoingEdgeMap = {};
            // "Canonical" incoming/outgoing edge properties -- these
            // are used to represent the ideal connections
            // between nodes regardless of collapsing
            incomingEdges.each(
                function(edge, j) {
                    incomingEdgeMap[edge.id()] =
                        [edge.source().id(), edge.target().id()];
                }
            );
            outgoingEdges.each(
                function(edge, j) {
                    outgoingEdgeMap[edge.id()] =
                        [edge.source().id(), edge.target().id()];
                }
            );
            // Get the "interior elements" of the cluster: all child nodes,
            // plus the edges connecting child nodes within the cluster
            // This considers cyclic edges (e.g. the edge connecting a
            // cycle's "end" and "start" nodes) as "interior elements,"
            // which makes sense as they don't connect the cycle's children
            //  to any elements outside the cycle.
            var interiorEdges = children.connectedEdges().difference(
                incomingEdges).difference(outgoingEdges);
            var wid = 0;
            var hgt = 0;
            // Basically, a cluster's width and height should be
            // reflective of the widths and heights of its children.
            // In the children.each block here we basically add the
            // approximate DNA lengths of each child (as reflected
            // in the width/height of the child node in question) to
            // an accumulator, and after the block we treat these
            // values like we treat normal node blocks and scale them
            // the same way (logarithmically).
            children.each(function(e, i) {
                wid += Math.pow(10, e.data("w") / INCHES_TO_PIXELS);
                hgt += Math.pow(10, e.data("h") / INCHES_TO_PIXELS);
            });
            wid = INCHES_TO_PIXELS * (Math.log(wid) / Math.log(10));
            hgt = INCHES_TO_PIXELS * (Math.log(hgt) / Math.log(10));
            // Record incoming/outgoing edges in this
            // cluster's data. Will be useful during collapsing.
            // We also record "interiorNodes" -- having a reference to just
            // these nodes saves us the time of filtering nodes out of
            // interiorEles when rotating collapsed node groups.
            node.data({
                "incomingEdgeMap"   : incomingEdgeMap,
                "outgoingEdgeMap"   : outgoingEdgeMap,
                "w"                 : wid,
                "h"                 : hgt,
                "interiorNodeCount" : children.size()
            });
            // We store collections of elements in the cluster's scratch data.
            // Storing it in the main "data" section will mess up the JSON
            // exporting, since it isn't serializable.
            // TODO reduce redundancy here -- only store interiorEles, and in
            // rotateNodes just select nodes from interiorEles
            node.scratch({
                "_interiorEles": interiorEdges.union(children),
                "_interiorNodes": children
            });
        }
    );
}

// returns the coordinate class for a cluster node in the graph (only
// respective to left/right vs. up/down direction)
function getClusterCoordClass() {
    if (CURR_ROTATION === 0 || CURR_ROTATION === 180) {
        return "updowndir";
    }
    else {
        return "leftrightdir";
    }
}

// returns the coordinate class for a noncluster node in the graph
function getNodeCoordClass(isHouse) {
    switch (CURR_ROTATION) {
        case 0:
            return isHouse ? "updir" : "downdir";
        case 90:
            return isHouse ? "leftdir" : "rightdir";
        case 180:
            return isHouse ? "downdir" : "updir";
        case 270:
            return isHouse ? "rightdir" : "leftdir";
    }
}

/* Renders a given node object, obtained by getAsObject() from running a
 * query on CURR_DB for selecting rows from table nodes.
 * Returns the new (in Cytoscape.js coordinates) position of the node.
 * cyNodeID is used as the node in Cytoscape.js for this node.
 * If mode is "SPQR", then this handles that accordingly w/r/t node shape, etc.
 */
function renderNodeObject(nodeObj, cyNodeID, boundingboxObject, mode) {
    var nx, ny;
    if (mode === "SPQR" && CURR_SPQRMODE === "implicit") {
        nx = nodeObj['i_x'];
        ny = nodeObj['i_y'];
    }
    else {
        nx = nodeObj['x'];
        ny = nodeObj['y'];
    }
    var pos = gv2cyPoint(nx, ny, [boundingboxObject['boundingbox_x'],
         boundingboxObject['boundingbox_y']]);
    
    var nodeShapeClass = "singlenode";
    if (mode !== "SPQR") {
        nodeShapeClass = getNodeCoordClass(nodeObj['shape'] === 'house');
    }
    var nodeLabel = nodeObj['label'];
    var labelUsed;
    // Determine 1) accession keys for nodes in scaffold detection, and 2) the
    // label to be shown when the node is drawn.
    if (ASM_FILETYPE === "GML") {
        if (nodeLabel !== null && nodeLabel !== undefined) {
            COMPONENT_NODE_KEYS.push(nodeLabel);
            labelUsed = nodeLabel;
        }
        else {
            // Fail silently (for now), allowing nodes without labels.
            // This will mean that this node will not be detected as being a
            // part of any scaffolds, since the scaffold detection process is
            // based on the filetype of the original input assembly graph.
            // (That is, scaffolds used for GML files are assumed to refer to
            // the labels of nodes, while scaffolds used for other filetypes
            // are assumed to refer to the IDs of nodes.)
            labelUsed = nodeObj['id'];
        }
    }
    else {
        COMPONENT_NODE_KEYS.push(nodeObj['id']);
        labelUsed = nodeObj['id'];
    }
    var parentID;
    var parentBicmpID = null;
    var nodeDepth = null;
    var nodeLength = null;
    var nodeGC = null;
    var nodeIsRepeat = null;
    if (mode === "SPQR") {
        parentID = nodeObj['parent_metanode_id'];
        if (CURR_SPQRMODE === "implicit") {
            // ensure this data is present for each bicomponent
            // there's probably a more efficient way to do this, but it's 2am
            // and I'm really tired so let's revisit this later (TODO #115)
            parentBicmpID = nodeObj['parent_bicomponent_id'];
            if (parentBicmpID !== null && parentBicmpID !== undefined) {
                // Since a bicomponent can contain only one node with a given
                // ID, we store normal node IDs and not unambiguous IDs here
                BICOMPONENTID2VISIBLESINGLENODEIDS[parentBicmpID]
                    .push(cyNodeID);
            }
        }
    }
    else {
        parentID = nodeObj['parent_cluster_id'];
    }
    nodeDepth = nodeObj['depth'];
    nodeLength = nodeObj['length'];
    nodeGC = nodeObj['gc_content'];
    nodeIsRepeat = nodeObj['is_repeat'];
    var gcColor = null;
    if (nodeGC !== null) {
        gcColor = getNodeColorization(nodeGC); 
    }
    var repeatColor = null;
    if (nodeIsRepeat !== undefined) {
        if (nodeIsRepeat === null) {
            // Repeat data exists for other nodes, but this node doesn't have
            // any given: color it the default node color
            repeatColor = DEFAULT_NODE_COLOR;
        }
        else {
            // We could call getNodeColorization() with nodeIsRepeat, but
            // since nodeIsRepeat can only be either 1 or 0 that'd be kind of
            // inefficient, since we can just use MAX_HEX and MIN_HEX.
            if (nodeIsRepeat === 1) {
                repeatColor = MAX_HEX;
            } else {
                repeatColor = MIN_HEX;
            }
        }
    }
    var nodeData = {id: cyNodeID, label: labelUsed,
               w: INCHES_TO_PIXELS * nodeObj['h'],
               h: INCHES_TO_PIXELS * nodeObj['w'], depth: nodeDepth,
               length: nodeLength, gc_content: nodeGC, gc_color: gcColor,
               repeat_color: repeatColor, is_repeat: nodeIsRepeat};
    if (parentID !== null) {
        var typeTag = parentID[0];
        // Don't assign explicit parents for metanodes/bicomponents in the SPQR
        // view. See issue #209 on GitHub for details.
        if (typeTag === 'B' || typeTag === 'F' || typeTag === 'C'
                || typeTag === 'Y') {
            nodeData["parent"] = parentID;
        } else {
            // For SPQR metanode collapsing
            if (CURR_SPQRMODE === "explicit") {
                cy.getElementById(parentID).scratch(
                    "_singlenodeIDs").push(cyNodeID);
            }
        }
        cy.scratch("_ele2parent")[cyNodeID] = parentID;
        // Allow for searching via node labels. This does increase the number
        // of entries in _ele2parent by |Nodes| (assuming every node in the
        // graph has a label given) -- so if that is too expensive for some
        // reason, I suppose this could be disallowed.
        if (nodeLabel !== null)
            cy.scratch("_ele2parent")[nodeLabel] = parentID;
    }
    cy.add({
        classes: 'noncluster ' + CURR_NODE_COLORIZATION + ' ' + nodeShapeClass,
        data: nodeData, position: {x: pos[0], y: pos[1]}
    });
    return pos;
}

// Draws two nodes that "enforce" the given bounding box.
function drawBoundingBoxEnforcingNodes(boundingboxObject) {
    var bb = [boundingboxObject['boundingbox_x'],
              boundingboxObject['boundingbox_y']];
    var bottomLeftPt = gv2cyPoint(0, 0, bb);
    var topRightPt = gv2cyPoint(bb[0], bb[1], bb);
    cy.add({
        classes: "bb_enforcing", data: {id: "bottom_left"},
        position: {x: bottomLeftPt[0], y: bottomLeftPt[1]}
    });
    cy.add({
        classes: "bb_enforcing", data: {id: "top_right"},
        position: {x: topRightPt[0], y: topRightPt[1]}
    });
}

function removeBoundingBoxEnforcingNodes() {
    cy.$("node.bb_enforcing").remove();
}

// Renders a cluster object.
// Used to draw bubbles, frayed ropes, chains, cyclic chains, bicomponents, and
// metanodes.
// If spqrtype is "bicomponent" or "metanode", this does things slightly
// differently than normal to make that work. Else, it just infers information
// about this metanode from the clusterObj.
// Returns an array of [clusterID, drawn position of this cluster], where the
// position is itself an array of [x pos, y pos].
function renderClusterObject(clusterObj, boundingboxObject, spqrtype) {
    var clusterID;
    var parent_bicmp_id = null;
    var spqrRelated = false;
    if (spqrtype === "bicomponent") {
        clusterID = "I" + clusterObj["id_num"];
        spqrRelated = true;
    }
    else if (spqrtype === "metanode") {
        clusterID = clusterObj["metanode_id"]; 
        parent_bicmp_id = "I" + clusterObj["parent_bicomponent_id_num"];
        spqrRelated = true;
    }
    else {
        clusterID = clusterObj["cluster_id"];
    }
    var l = "left";
    var b = "bottom";
    var r = "right";
    var t = "top";
    if (spqrRelated && CURR_SPQRMODE === "implicit") {
        l = "i_" + l;
        b = "i_" + b;
        r = "i_" + r;
        t = "i_" + t;
    }
    var bottomLeftPos = gv2cyPoint(clusterObj[l], clusterObj[b],
        [boundingboxObject['boundingbox_x'],
         boundingboxObject['boundingbox_y']]);
    var topRightPos = gv2cyPoint(clusterObj[r], clusterObj[t],
        [boundingboxObject['boundingbox_x'],
         boundingboxObject['boundingbox_y']]);
    var clusterData = {id: clusterID,
        w: Math.abs(topRightPos[0] - bottomLeftPos[0]),
        h: Math.abs(topRightPos[1] - bottomLeftPos[1]),
        isCollapsed: false};
    // Only assign the metanode a bicomponent parent when in explicit mode
    if (parent_bicmp_id !== null && CURR_SPQRMODE === "explicit") {
        clusterData["parent"] = parent_bicmp_id;
    }
    var pos = [(bottomLeftPos[0] + topRightPos[0]) / 2,
               (bottomLeftPos[1] + topRightPos[1]) / 2];
    var abbrev = clusterID[0];
    var classes = abbrev + ' cluster ' + getClusterCoordClass();
    if (!spqrRelated) {
        classes += ' structuralPattern';
        COMPONENT_NODE_KEYS.push(clusterID);
        clusterData["length"] = clusterObj["length"];
    }
    else if (spqrtype === "metanode") {
        // We use the "pseudoparent" class to represent compound nodes that
        // have the potential to contain an arbitrarily large amount of child
        // nodes. Initial rendering performance drops noticeably when many
        // child nodes are in the same parent. To compensate for this, we just
        // make these nodes "pseudoparents" -- they're styled similarly to
        // normal compound nodes, but they don't actually contain any nodes.
        classes += ' spqrMetanode';
        clusterData["descendantCount"]=clusterObj["descendant_metanode_count"];
        // since we "collapse" all metanodes by default (collapsing takes on a
        // different meaning w/r/t SPQR metanodes, as opposed to normal
        // structural variants)
        clusterData["isCollapsed"] = true;
    }
    if (spqrRelated) {
        classes += ' pseudoparent';
        // Since this node won't actually be assigned child nodes (but still
        // has "children" in some abstract way), we manually set its node count
        if (CURR_SPQRMODE === "implicit" && spqrtype === "bicomponent") {
            clusterData["interiorNodeCount"] = "N/A";
        }
        else {
            clusterData["interiorNodeCount"] = clusterObj["node_count"];
        }
    }
    var newObj = cy.add({
        classes: classes, data: clusterData,
        position: {x: pos[0], y: pos[1]},
        locked: spqrRelated
    });
    if (spqrtype === "metanode") {
        if (CURR_SPQRMODE === "explicit") {
            // For SPQR metanode collapsing/uncollapsing
            newObj.scratch("_singlenodeIDs", []);
        }
        else {
            // For implicit SPQR collapsing
            newObj.scratch("_virtualedgeIDs", []);
        }
    }
    else if (spqrtype === "bicomponent" && CURR_SPQRMODE === "implicit") {
        // for implicit mode uncollapsing
        // mapping of bicomponent IDs to visible singlenode IDs -- updated as
        // we expand the SPQR tree represented by the given bicomponent
        // this is done to prevent adding duplicates within a given tree
        BICOMPONENTID2VISIBLESINGLENODEIDS[clusterID] = [];
    }
    else {
        // For variant collapsing/uncollapsing
        cy.scratch("_uncollapsed", cy.scratch("_uncollapsed").union(newObj));
    }
    return [clusterID, pos];
}

/* Renders edge object. Hopefully in a not-terrible way.
 *
 * Uses node2pos (mapping of node object from DB -> [x, y] position)
 * to calcluate relative control point weight stuff.
 *
 * If edgeType === "metanodeedge" then this accesses the edge's attributes
 * accordingly. Otherwise, it assumes the edge has normal source_id and
 * target_id parameters.
 *
 * If mode === "SPQR" then this does a few things differently (mostly related
 * to not getting certain values from the edge's attributes, etc).
 *
 * If actualIDmapping !== {}, then the source/target IDs assigned to this edge
 * will be replaced accordingly. So, for example, if we were going to render an
 * edge from singlenode 3 to 4 (both in, say, a P-metanode with ID abc), but
 * actualIDmapping says something like {"3": "3def", "4": "4def"}, then we'll
 * adjust the node IDs to use the "def" suffix instead. This feature is used
 * when adding edges in the implicit SPQR mode uncollapsing feature.
 */
function renderEdgeObject(edgeObj, node2pos, boundingboxObject, edgeType,
        mode, actualIDmapping) {
    var sourceID, targetID;
    // If the edge is in "regular mode", make its ID what it was before:
    // srcID + "->" + tgtID.
    // If this is in SPQR mode, give the edge displaySourceID and
    // displayTargetID properties and then we'll use those in
    // addSelectedEdgeInfo() based on CURR_VIEWTYPE.
    if (edgeType === "metanodeedge") {
        sourceID = edgeObj['source_metanode_id'];
        targetID = edgeObj['target_metanode_id'];
    }
    else {
        var displaySourceID = edgeObj['source_id'];
        var displayTargetID = edgeObj['target_id'];
        sourceID = displaySourceID;
        targetID = displayTargetID;
        if (mode === "SPQR") {
            // we're drawing an edge in the SPQR-integrated view that is not
            // incident on metanodes. That is, this edge is either between two
            // actual nodes, between a node and a bicomponent, or between two
            // bicomponents.
            // We render these edges as normal basicbeziers to simplify things
            // (they usually seem to be straight lines/normal beziers anyway)
            var edgeClasses = "basicbezier";
            if (sourceID === targetID) {
                edgeClasses += " unoriented_loop";
            }
            var parent_mn_id = edgeObj['parent_metanode_id'];
            var isVirtual = false;
            if (parent_mn_id !== null) {
                // This singleedge is in a metanode's skeleton.
                if (actualIDmapping[sourceID] !== undefined) {
                    sourceID = actualIDmapping[sourceID];
                }
                else {
                    sourceID += "_" + parent_mn_id;
                }
                if (actualIDmapping[targetID] !== undefined) {
                    targetID = actualIDmapping[targetID];
                }
                else {
                    targetID += "_" + parent_mn_id;
                }
                if (edgeObj['is_virtual'] !== 0) {
                    // We do this check here because virtual edges can only
                    // exist in metanode skeletons
                    edgeClasses += " virtual";
                    isVirtual = true;
                }
            }
            var addNote = false;
            if (CURR_SPQRMODE === "implicit" && isVirtual) {
                if (cy.getElementById(parent_mn_id).empty()) {
                    return;
                }
                else {
                    addNote = true;
                }
            }
            var e = cy.add({
                classes: edgeClasses,
                data: {source: sourceID, target: targetID,
                       dispsrc: displaySourceID, disptgt: displayTargetID,
                       thickness: MAX_EDGE_THICKNESS}
            });
            if (addNote) {
                cy.getElementById(parent_mn_id).scratch(
                    "_virtualedgeIDs").push(e.id());
            }
            return;
        }
    }
    var multiplicity, thickness, is_outlier, orientation, mean, stdev;
    if (mode !== "SPQR") { // (edges between metanodes don't have metadata)
        multiplicity = edgeObj['multiplicity'];
        thickness = edgeObj['thickness'];
        is_outlier = edgeObj['is_outlier'];
        orientation = edgeObj['orientation'];
        mean = edgeObj['mean'];
        stdev = edgeObj['stdev'];
        if (multiplicity !== undefined && multiplicity !== null) {
            COMPONENT_EDGE_WEIGHTS.push(+multiplicity);
        }
    }
    else {
        // Make edges between metanodes be handled properly
        thickness = 0.5;
        is_outlier = 0;
    }
    // If we're at this point, we're either in the regular view mode or we're
    // drawing an edge between metanodes. In either case, this means that we
    // know that this edge is not a multi-edge (i.e. it has a unique source and
    // target). Therefore we can set the edge's ID as follows.
    var edgeID = sourceID + "->" + targetID;
    if (edgeObj['parent_cluster_id'] !== null) {
        cy.scratch("_ele2parent")[edgeID] = edgeObj['parent_cluster_id'];
    }
    // If bundle sizes are available, then don't show edges with a bundle size
    // below a certain threshold. NOTE that this feature is disabled for the
    // time being, but can be reenabled eventually (consider adding a minimum
    // bundle size threshold that is configurable by the user; also, rewrite
    // to focus on multiplicity instead of bundlesize since the two terms are
    // basically equivalent)
    //var bundlesize = edgeObj['bundlesize'];
    //if (bundlesize !== null && bundlesize < MIN_BUNDLE_SIZE) {
    //    return;
    //}

    // NOTE -- commented out for now in lieu of global edge thickness scaling
    // Scale edge thickness using the "thickness" .db file attribute
    var edgeWidth = MIN_EDGE_THICKNESS + (thickness * EDGE_THICKNESS_RANGE);
    var isOutlierClass = "";
    if (is_outlier === 1)
        isOutlierClass = " high_outlier";
    else if (is_outlier === -1)
        isOutlierClass = " low_outlier";
    // Scale edge thickness relative to all other edges in the current
    // connected component
    if (sourceID === targetID) {
        // It's a self-directed edge; don't bother parsing ctrl pt
        // info, just render it as a bezier edge and be done with it
        cy.add({
            classes: "basicbezier oriented" + isOutlierClass,
            data: {source: sourceID, target: targetID,
                   thickness: edgeWidth, multiplicity: multiplicity,
                   orientation: orientation, mean: mean, stdev: stdev}
        });
        return;
    }
    var srcPos = node2pos[sourceID];
    var tgtPos = node2pos[targetID];
    //console.log("src: " + sourceID);
    //console.log("tgt: " + targetID);
    var srcSinkDist = distance(srcPos, tgtPos);
    var ctrlPts = ctrlPtStrToList(edgeObj['control_point_string'],
            [boundingboxObject['boundingbox_x'],
             boundingboxObject['boundingbox_y']]);
    var ctrlPtLen = edgeObj['control_point_count'];
    var nonzero = false;
    var ctrlPtDists = "";
    var ctrlPtWeights = "";
    var currPt, dsp, dtp, w, ws, wt, nonzero;
    for (var p = 0; p < ctrlPtLen; p++) {
        currPt = ctrlPts[p];
        // TODO inefficiency here -- rework pointToLineDistance.
        var d = -pointToLineDistance(currPt,
            {x: srcPos[0], y: srcPos[1]}, {x: tgtPos[0], y: tgtPos[1]});
        dsp = distance(currPt, srcPos);
        dtp = distance(currPt, tgtPos);
        // By the pythagorean thm., the interior of the square root
        // below should always be positive -- the hypotenuse must
        // always be greater than both of the other sides of a right
        // triangle.
        // However, due to Javascript's lovely (...)
        // type system, rounding errors can cause the hypotenuse (dsp
        // or dtp)
        // be represented as slightly less than d. So, to account for
        // these cases, we just take the abs. value of the sqrt body.
        // NOTE that ws = distance on line to source;
        //           wt = distance on line to target
        ws = Math.sqrt(Math.abs(Math.pow(dsp, 2) - Math.pow(d, 2)));
        wt = Math.sqrt(Math.abs(Math.pow(dtp, 2) - Math.pow(d, 2)));
        // Get the weight of the control point on the line between
        // source and sink oriented properly -- if the control point is
        // "behind" the source node, we make it negative, and if the
        // point is "past" the sink node, we make it > 1. Everything in
        // between the source and sink falls within [0, 1] inclusive.
        if (wt > srcSinkDist && wt > ws) {
            // The ctrl. pt. is "behind" the source node
            w = -ws / srcSinkDist;
        }
        else {
            // The ctrl. pt. is anywhere past the source node
            w = ws / srcSinkDist;
        }
        // If we detect all of the control points of an edge are less
        // than some epsilon value, we just render the edge as a normal
        // bezier (which defaults to a straight line).
        if (Math.abs(d) > CTRL_PT_DIST_EPSILON) {
            nonzero = true;
        }
        // Control points with a weight of 0 (as the first ctrl pt)
        // or a weight of 1 (as the last ctrl pt) aren't valid due
        // to implicit points already "existing there."
        // (See https://github.com/cytoscape/cytoscape.js/issues/1451)
        // This preemptively rectifies such control points.
        if (p === 0 && w === 0.0) {
            w = 0.01;
        }
        else if (p === (ctrlPtLen - 1) && w === 1.0) {
            w = 0.99;
        }
        ctrlPtDists += d.toFixed(2) + " ";
        ctrlPtWeights += w.toFixed(2) + " ";
    }
    ctrlPtDists = ctrlPtDists.trim();
    ctrlPtWeights = ctrlPtWeights.trim();
    var extraClasses = " oriented" + isOutlierClass;
    if (ASM_FILETYPE === "GML") {
        // Mark edges where nodes don't overlap
        // TODO: Make this work with GFA edges also.
        // (See #190 on GitHub.)
        //if (mean !== null && mean !== undefined && mean > 0) {
        //    extraClasses += " nooverlap";
        //}
    }
    if (nonzero) {
        // The control points should (hopefully) be valid
        cy.add({
            classes: "unbundledbezier" + extraClasses,
          data: {source: sourceID, target: targetID,
                 cpd: ctrlPtDists, cpw: ctrlPtWeights,
                 thickness: edgeWidth, multiplicity: multiplicity,
                 orientation: orientation, mean: mean, stdev: stdev}
        });
    }
    else {
        // The control point distances are small enough that
        // we can just represent this as a straight bezier curve
      cy.add({
          classes: "basicbezier" + extraClasses,
          data: {source: sourceID, target: targetID,
                 thickness: edgeWidth, multiplicity: multiplicity,
                 orientation: orientation, mean: mean, stdev: stdev}
      });
    }
}

/* Given two points, each in the form [x, y], returns the distance between
 * the points obtained using d = sqrt((x2 - x1)^2 + (y2 - y1)^2).
 * e.g. distance([1, 2], [3, 4]) = sqrt((3 - 1)^2 + (4 - 2)^2) = sqrt(8)
 */
function distance(point1, point2) {
    return Math.sqrt(
              Math.pow(point2[0] - point1[0], 2)
            + Math.pow(point2[1] - point1[1], 2)
    );
}

/* Given a line that passes through two Nodes -- lNode1 and lNode2
 * -- this function returns the perpendicular distance from a point to the
 * line.
 */
function pointToLineDistance(point, lNode1, lNode2) {
    var lDist = distance([lNode1.x, lNode1.y], [lNode2.x, lNode2.y]);
    if (lDist === 0) {
        return 0;
    }
    var ydelta = lNode2.y - lNode1.y;
    var xdelta = lNode2.x - lNode1.x;
    var consts = (lNode2.x * lNode1.y) - (lNode2.y * lNode1.x);
    var numer = (ydelta * point[0]) - (xdelta * point[1]) + consts;
    return numer / lDist;
}
