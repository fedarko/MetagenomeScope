#!/usr/bin/env python
# Converts an assembly graph (LastGraph, GFA, Bambus 3 GML) to a DOT file,
# lays out the DOT file using GraphViz to produce XDOT output, and
# then reconciles the layout data with biological data in a SQLite .db
# file that can be read by the AsmViz viewer.
#
# For usage information, please see README.md in the root directory of AsmViz.

# For getting command-line arguments
from sys import argv, stdout
# For running the C++ spqr script binary
from subprocess import check_output, STDOUT
# For running dot, GraphViz' main layout manager
import pygraphviz
# For creating a directory in which we store xdot/gv files, and for file I/O
import os
# For checking I/O errors
import errno
# For interfacing with the SQLite Database
import sqlite3

import graph_objects
import config

# Get argument information
asm_fn = ""
output_fn = ""
db_fn = ""
dir_fn = ""
preserve_gv = False
preserve_xdot = False
overwrite = False
use_dna = True
double_graph = True
i = 1
# Possible TODO here: use a try... block here to let the user know if they
# passed in arguments incorrectly, in a more user-friendly way
# Also we should probably validate that the filenames for -i and -o are
# valid -- look into ArgParse?
for arg in argv[1:]:
    if (arg == "-i" or arg == "-o" or arg == "-d") and i == len(argv) - 1:
        # If this is the last argument, then no filename is given.
        # This is obviously invalid. (This allows us to avoid out of bounds
        # errors when accessing argv[i + 1].)
        raise ValueError, config.NO_FN_ERR + arg
    if arg == "-i":
        asm_fn = argv[i + 1]
    elif arg == "-o":
        output_fn = argv[i + 1]
        db_fn = output_fn + ".db"
    elif arg == "-d":
        dir_fn = argv[i + 1]
    elif arg == "-pg":
        preserve_gv = True
    elif arg == "-px":
        preserve_xdot = True
    elif arg == "-w":
        overwrite = True
    elif arg == "-nodna":
        use_dna = False
    elif arg == "-s":
        # we don't do anything with this yet (see #10 on GitHub)
        double_graph = False
    elif i == 1 or argv[i - 1] not in ["-i", "-o", "-d"]:
        # If a valid "argument" doesn't match any of the above types,
        # then it must be a filename passed to -i, -o, or -d.
        # If it isn't (what this elif case checks for), 
        # then the argument is invalid and we need to raise an error.
        raise ValueError, config.ARG_ERR + arg
    i += 1

if asm_fn == "" or output_fn == "":
    raise ValueError, config.NO_FN_PROVIDED_ERR

if dir_fn == "":
    dir_fn = os.getcwd()

try:
    os.makedirs(dir_fn)
except:
    if not os.path.isdir(dir_fn):
        raise IOError, dir_fn + config.EXISTS_AS_NON_DIR_ERR

# Assign flags for auxiliary file creation
if overwrite:
    flags = os.O_CREAT | os.O_TRUNC | os.O_WRONLY
else:
    flags = os.O_CREAT | os.O_EXCL | os.O_WRONLY

def check_file_existence(filepath):
    """Returns True if the given filepath does exist as a non-directory file
       and overwrite is set to True.

       Returns False if the given filepath does not exist at all.

       Raises errors if:
        -The given filepath does exist but overwrite is False
        -The given filepath exists as a directory

       Note that this has some race conditions associated with it -- the
       user or some other process could circumvent these error-checks by,
       respectively:
        -Creating a file at the filepath after this check but before opening
        -Creating a directory at the filepath after this check but before
         opening

       We get around this by using os.fdopen() wrapped to os.open() with
       certain flags (based on whether or not the user passed -w) set,
       for the one place in this script where we directly write to a file
       (in save_aux_file()). This allows us to guarantee an error will be
       thrown and no data will be erroneously written in the first two cases,
       while (for most non-race-condition cases) allowing us to display a
       detailed error message to the user here, before we even try to open the
       file.
    """
    if os.path.exists(filepath):
        basename = os.path.basename(filepath)
        if os.path.isdir(filepath):
            raise IOError, basename + config.IS_DIR_ERR
        if not overwrite:
            raise IOError, basename + config.EXISTS_ERR
        return True
    return False

def safe_file_remove(filepath):
    """Safely (preventing race conditions of the file already being removed)
       removes a file located at the given file path.
    """
    try:
        os.remove(filepath)
    except OSError as error:
        if error.errno == errno.ENOENT:
            # Something removed the file before we could. That's alright.
            pass
        else:
            # Something strange happened -- maybe someone changed the file
            # to a directory, or something similarly odd. Raise the original
            # error to inform the user.
            raise

# Right off the bat, check if the .db file name causes an error somehow.
# (See check_file_existence() for possible causes.)
# This prevents us from doing a lot of work and then realizing that due to the
# nature of the .db file name we can't continue.
# Yeah, there is technically a race condition here where the user/some process
# could create a file with the same .db name in between us checking for its
# existence here/etc. and us actually connecting to the .db file using SQLite.
# However, as is detailed below, that doesn't really matter -- SQLite will
# handle that condition suitably.
db_fullfn = os.path.join(dir_fn, db_fn)
if check_file_existence(db_fullfn):
    # The user asked to overwrite this database via -w, so remove it
    safe_file_remove(db_fullfn)

def dfs(n):
    """Recursively runs depth-first search, starting at node n.
       Returns a list of all nodes found that corresponds to a list of all
       nodes within the entire connected component (ignoring edge
       directionality) in which n resides.
       
       This assumes that the connected component containing n has not had this
       method run on it before (due to its reliance on the .seen_in_dfs Node
       property).

       (In identifying a connected component, the graph is treated as if
       its edges are undirected, so the actual starting node within a
       connected component should not make a difference on the connected
       component node list returned.)

       I modified this function to not use recursion since Python isn't
       super great at that -- this allows us to avoid hitting the maximum
       recursion depth, which would cause us to get a RuntimeError for
       really large connected components.
    """
    nodes_to_check = [n]
    nodes_in_ccomponent = []
    # len() of a list in python is a constant-time operation, so this is okay--
    while len(nodes_to_check) > 0:
        # We rely on the invariant that all nodes in nodes_to_check have
        # seen_in_dfs = False, and that no duplicate nodes exist within
        # nodes_to_check
        j = nodes_to_check.pop()
        j.seen_in_dfs = True
        nodes_in_ccomponent.append(j)
        tentative_nodes = j.outgoing_nodes + j.incoming_nodes
        # Only travel to unvisited and not already-marked-to-visit neighbor
        # nodes of j
        for m in tentative_nodes:
            if not m.seen_in_dfs and not m.in_nodes_to_check:
                # in_nodes_to_check prevents duplicate nodes in that list
                m.in_nodes_to_check = True
                nodes_to_check.append(m)
    return nodes_in_ccomponent

def reverse_complement(dna_string):
    """Returns the reverse complement of a string of DNA.
   
       e.g. reverse_complement("GCATATA") == "TATATGC"
   
       This is used when getting data from GFA files (which only include
       positive DNA sequence information).
       
       Note that this will break on invalid DNA input (so inputs like RNA
       or protein sequences, or sequences that contain spaces, will cause
       this to fail).
    """
    rc = ""
    dna_last_char_index = len(dna_string) - 1
    for nt in range(dna_last_char_index, -1, -1):
        rc += config.COMPLEMENT[dna_string[nt]] 
    return rc

def gc_content(dna_string):
    """Returns the GC content (as a float in the range [0, 1]) of a string of
       DNA, in a 2-tuple with the second element of the tuple being the
       actual number of Gs and Cs in the dna_string.
       
       Assumes that the string of DNA only contains nucleotides (e.g., it
       doesn't contain any spaces).

       For reference, the GC content of a DNA sequence is the percentage of
       nucleotides within the sequence that are either G (guanine) or C
       (cytosine).

       e.g. gc_content("GCATTCAC") == (0.5, 4)
    """
    # len() of a str is a constant-time operation in Python
    seq_len = len(dna_string)
    gc_ct = 0
    for nt in dna_string:
        if nt == 'G' or nt == 'C':
            gc_ct += 1
    return (float(gc_ct) / seq_len), gc_ct

def assembly_gc(gc_ct, total_bp):
    """Returns the G/C content of an assembly, where total_bp is the number of
       base pairs (2 * the number of nucleotides) and gc_ct is the number of
       G/C nucleotides in the entire assembly.
    """
    if gc_ct == None:
        return None
    else:
        return float(gc_ct) / (2 * total_bp)

def negate_node_id(id_string):
    """Negates a node ID.
    
       e.g. "c18" -> "18", "18" -> "c18"
    """
    if id_string[0] == '-':
        return id_string[1:]
    else:
        return '-' + id_string

def n50(node_lengths):
    """Determines the N50 statistic of an assembly, given its node lengths.

       Note that multiple definitions of the N50 statistic exist (see
       https://en.wikipedia.org/wiki/N50,_L50,_and_related_statistics for
       more information).
       
       Here, we use the calculation method described by Yandell and Ence,
       2012 (Nature) -- see
       http://www.nature.com/nrg/journal/v13/n5/box/nrg3174_BX1.html for a
       high-level overview.
    """

    if len(node_lengths) == 0:
        raise ValueError, config.EMPTY_LIST_N50_ERR
    sorted_lengths = sorted(node_lengths, reverse=True)
    i = 0
    running_sum = 0
    half_total_length = 0.5 * sum(sorted_lengths)
    while running_sum < half_total_length:
        if i >= len(sorted_lengths):
            # This should never happen, but just in case
            raise IndexError, config.N50_CALC_ERR
        running_sum += sorted_lengths[i]
        i += 1
    # Return length of shortest node that was used in the running sum
    return sorted_lengths[i - 1]

def save_aux_file(aux_filename, source, layout_msg_printed, warnings=True):
    """Given a filename and a source of "input" for the file, writes to that
       file (using check_file_existence() accordingly).

       If aux_filename ends with ".xdot", we assume that source is a
       pygraphviz.AGraph object of which we will write its "drawn" xdot output
       to the file.

       Otherwise, we assume that source is just a string of text to write
       to the file.

       If check_file_existence() gives us an error (or if os.open() gives
       us an error due to the flags we've used), we don't save the
       aux file in particular. The default behavior (if warnings=True) in this
       case is to print an error message accordingly (its
       formatting depends partly on whether or not a layout message for
       the current component was printed [given here as layout_msg_printed,
       a boolean variable] -- if so [i.e. layout_msg_printed is True], the
       error message here is printed on a explicit newline and followed
       by a trailing newline. Otherwise, the error message here is just printed
       with a trailing newline).
       
       However, if warnings=False and we get an error from either possible
       source (check_file_existence() or os.open()) then this will
       throw an error. Setting warnings=False should only be done for
       operations that are required to generate a .db file -- care should be
       taken to ensure that .db files aren't partially created before trying
       save_aux_file with warnings=False, since that could result in an
       incomplete .db file being generated (which might confuse users).
       If warnings=False, then the value of layout_msg_printed is not used.

       Returns True if the file was written successfully; else, returns False.
    """
    fullfn = os.path.join(dir_fn, aux_filename)
    ex = None
    try:
        ex = check_file_existence(fullfn)
        # We use the defined flags (based on whether or not -w was passed)
        # to ensure some degree of atomicity in our file operations here,
        # preventing errors whenever possible
        with os.fdopen(os.open(fullfn, flags, config.AUXMOD), 'w') as file_obj:
            if aux_filename.endswith(".xdot"):
                file_obj.write(source.draw(format="xdot"))
            else:
                file_obj.write(source)
        return True
    except (IOError, OSError) as e:
        # An IOError indicates check_file_existence failed, and (far less
        # likely, but still technically possible) an OSError indicates
        # os.open failed
        msg = config.SAVE_AUX_FAIL_MSG + "%s: %s" % (aux_filename, e)
        if not warnings:
            raise type(e), msg
        # If we're here, then warnings = True.
        # Don't save this file, but continue the script's execution.
        if layout_msg_printed:
            operation_msg("\n" + msg, newline=True)
        else:
            operation_msg(msg, newline=True)
        return False

def operation_msg(message, newline=False):
    """Prints a message (by default, no trailing newline), then flushes stdout.

       Flushing stdout helps to ensure that the user sees the message (even
       if it is followed by a long operation in this program). The trailing
       newline is intended for use with conclude_msg(), defined below.
    """
    if newline: print message
    else: print message,
    stdout.flush()

def conclude_msg(message=config.DONE_MSG):
    """Prints a message indicating that a long operation was just finished.
       
       This message will usually be appended on to the end of the previous
       printed text (due to use of operation_msg), to save vertical terminal
       space (and look a bit fancy).
    """       
    print message

# Maps Node ID (as int) to the Node object in question
# This is nice, since it allows us to do things like nodeid2obj.values()
# to get a list of every Node object that's been processed
# (And, more importantly, to reconcile edge data with prev.-seen node data)
nodeid2obj = {}
# Like nodeid2obj, but for preserving references to clusters (NodeGroups)
clusterid2obj = {}

# Pertinent Assembly-wide information we use 
graph_filetype = ""
total_node_count = 0
total_edge_count = 0
total_length = 0
total_gc_nt_count = 0
total_component_count = 0
# List of all the node lengths in the assembly. Used when calculating n50.
bp_length_list = []

# Below "with" block parses the assembly file.
# Please consult the README for the most accurate list of assembly graph
# filetypes supported.
operation_msg(config.READ_FILE_MSG + "%s..." % (os.path.basename(asm_fn)))
with open(asm_fn, 'r') as assembly_file:
    # We don't really care about case in file extensions
    lowercase_asm_fn = asm_fn.lower()
    parsing_LastGraph = lowercase_asm_fn.endswith(config.LASTGRAPH_SUFFIX)
    parsing_GML       = lowercase_asm_fn.endswith(config.GRAPHML_SUFFIX)
    parsing_GFA       = lowercase_asm_fn.endswith(config.GFA_SUFFIX)
    if parsing_LastGraph:
        graph_filetype = "LastGraph"
        # TODO -- Should we account for SEQ/NR information here?
        curr_node_id = ""
        curr_node_bp = 1
        curr_node_depth = 1
        curr_node_dnafwd = None
        curr_node_dnarev = None
        curr_node_gcfwd = None
        curr_node_gcrev = None
        parsing_node = False
        parsed_fwdseq = False
        for line in assembly_file:
            if line[:4] == "NODE":
                parsing_node = True
                l = line.split()
                curr_node_id = l[1]
                curr_node_bp = int(l[2])
                # depth = $O_COV_SHORT1 / $COV_SHORT1 (bp)
                curr_node_depth = float(l[3]) / curr_node_bp
            elif line[:3] == "ARC":
                # ARC information is only stored on one line -- makes things
                # simple for us
                a = line.split()
                # Per the Velvet docs: "This one line implicitly represents
                # an arc from node A to B and another, with same
                # multiplicity, from -B to -A."
                # (http://computing.bio.cam.ac.uk/local/doc/velvet.pdf)
                id1 = a[1]
                id2 = a[2]
                if double_graph:
                    nid2 = negate_node_id(id2)
                    nid1 = negate_node_id(id1)
                else:
                    if id1[0] == '-': id1 = id1[1:]
                    if id2[0] == '-': id2 = id2[1:]
                mult = int(a[3])
                nodeid2obj[id1].add_outgoing_edge(nodeid2obj[id2],
                        multiplicity=mult)
                # Only add implied edge if the edge does not imply itself
                # (see issue #105 on GitHub for context)
                if double_graph and not (id1 == nid2 and id2 == nid1):
                    nodeid2obj[nid2].add_outgoing_edge(nodeid2obj[nid1],
                            multiplicity=mult)
                # Record this edge for graph statistics
                total_edge_count += 1
            elif parsing_node:
                # If we're in the middle of parsing a node's info and
                # the current line doesn't match either a NODE or ARC
                # declaration, then it refers to the node's DNA sequence.
                # It can either refer to the forward or reverse sequence -- in
                # LastGraph files, the forward sequence occurs first.
                if parsed_fwdseq:
                    # Parsing reverse sequence
                    curr_node_dnarev = line.strip()
                    curr_node_gcrev, gc_ct = gc_content(curr_node_dnarev)
                    total_gc_nt_count += gc_ct
                    if not use_dna:
                        curr_node_dnarev = None
                    # In any case, now that we've parsed both the forward and
                    # reverse sequences for the node's DNA (or ignored the
                    # sequences, if the user passed the -nodna flag), we are
                    # done getting data for this node -- so we can create new
                    # Node objects to be added to the .db file and used in the
                    # graph layout.
                    n = graph_objects.Node(curr_node_id, curr_node_bp, False,
                            depth=curr_node_depth, gc_content=curr_node_gcfwd,
                            dna_fwd=curr_node_dnafwd,
                            single_node=(not double_graph))
                    nodeid2obj[curr_node_id] = n
                    if double_graph:
                        c = graph_objects.Node('-' + curr_node_id,
                                curr_node_bp, True, depth=curr_node_depth,
                                gc_content=curr_node_gcrev,
                                dna_fwd=curr_node_dnarev)
                        nodeid2obj['-' + curr_node_id] = c
                        bp_length_list.append(curr_node_bp)
                    # Record this node for graph statistics
                    # Note that recording these statistics here ensures that
                    # only "fully complete" node definitions are recorded.
                    total_node_count += 1
                    total_length += curr_node_bp
                    bp_length_list.append(curr_node_bp)
                    # Clear temporary/marker variables for later use
                    curr_node_id = ""
                    curr_node_bp = 1
                    curr_node_dnafwd = None
                    curr_node_dnarev = None
                    curr_node_gcfwd = None
                    curr_node_gcrev = None
                    parsing_node = False
                    parsed_fwdseq = False
                else:
                    # Parsing forward sequence (It's actually offset by a
                    # number of bp, so we should probably mention that in
                    # README or even in the Javascript graph viewer)
                    parsed_fwdseq = True
                    curr_node_dnafwd = line.strip()
                    curr_node_gcfwd, gc_ct = gc_content(curr_node_dnafwd)
                    total_gc_nt_count += gc_ct
                    if not use_dna:
                        curr_node_dnafwd = None
    elif parsing_GML:
        graph_filetype = "GML"
        # Since GML files don't contain DNA
        total_gc_nt_count = None
        # Record state -- parsing node or parsing edge?
        # (This is kind of a lazy approach, but to be fair it's actually
        # sort of efficient)
        # We assume that each declaration occurs on its own line.
        parsing_node = False
        curr_node_id = None
        curr_node_bp = 0
        curr_node_orientation = None
        parsing_edge = False
        curr_edge_src_id = None
        curr_edge_tgt_id = None
        curr_edge_orientation = None
        curr_edge_mean = None
        curr_edge_stdev = None
        curr_edge_bundlesize = None
        for line in assembly_file:
            # Record node attributes/detect end of node declaration
            if parsing_node:
                if line.strip().startswith("id"):
                    l = line.split()
                    curr_node_id = l[1]
                elif line.strip().startswith("orientation"):
                    l = line.split()
                    curr_node_orientation = l[1] # either "FOW" or "REV"
                elif line.strip().startswith("length"):
                    # fetch value from length attribute
                    l = line.split()
                    curr_node_bp = int(l[1].strip("\""))
                elif line.endswith("]\n"):
                    n = graph_objects.Node(curr_node_id, curr_node_bp,
                            (curr_node_orientation == '"REV"'))
                    nodeid2obj[curr_node_id] = n
                    # Record this node for graph statistics
                    total_node_count += 1
                    total_length += curr_node_bp
                    bp_length_list.append(curr_node_bp)
                    # Clear tmp/marker variables
                    parsing_node = False
                    curr_node_id = None
                    curr_node_bp = 0
                    curr_node_orientation = None
            elif parsing_edge:
                if line.strip().startswith("source"):
                    l = line.split()
                    curr_edge_src_id = l[1]
                elif line.strip().startswith("target"):
                    l = line.split()
                    curr_edge_tgt_id = l[1]
                elif line.strip().startswith("orientation"):
                    l = line.split()
                    curr_edge_orientation = l[1].strip('"')
                elif line.strip().startswith("bsize"):
                    l = line.split()
                    curr_edge_bundlesize = int(l[1].strip('"'))
                elif line.strip().startswith("mean"):
                    l = line.split()
                    curr_edge_mean = float(l[1].strip('"'))
                elif line.strip().startswith("stdev"):
                    l = line.split()
                    curr_edge_stdev = float(l[1].strip('"'))
                elif line.endswith("]\n"):
                    nodeid2obj[curr_edge_src_id].add_outgoing_edge(
                            nodeid2obj[curr_edge_tgt_id],
                            multiplicity=curr_edge_bundlesize,
                            orientation=curr_edge_orientation,
                            mean=curr_edge_mean,
                            stdev=curr_edge_stdev)
                    total_edge_count += 1
                    # Clear tmp/marker vars
                    parsing_edge = False
                    curr_edge_src_id = None
                    curr_edge_tgt_id = None
                    curr_edge_orientation = None
                    curr_edge_bundlesize = None
                    curr_edge_mean = None
                    curr_edge_stdev = None
            # Start parsing node
            elif line.endswith("node [\n"):
                parsing_node = True
            # Start parsing edge
            elif line.endswith("edge [\n"):
                parsing_edge = True
    elif parsing_GFA:
        graph_filetype = "GFA"
        # NOTE--
        # Currently, we only parse (S)egment and (L)ink lines in GFA files,
        # and only take into account their "required" fields (as given on the
        # GFA spec).
        # TODO--
        # We can look into parsing S+L optional fields, as well as
        # (C)ontainment and (P)ath lines (and, more
        # importantly, making use of this data in the AsmViz viewer) in the
        # future, but for now having Segment + Link data should match what we
        # have for the other two supported input assembly graph filetypes.
        curr_node_id = None
        curr_node_bp = None
        curr_node_gc = None
        curr_node_dnafwd = None
        curr_node_dnarev = None
        for line in assembly_file:
            # Parsing a segment (node) line
            if line.startswith("S"):
                # For GFA files: given a + DNA seq, its - DNA seq is the
                # reverse complement of that DNA seq.
                l = line.split()
                curr_node_id = l[1]
                if curr_node_id.startswith("NODE_"):
                    curr_node_id = curr_node_id.split("_")[1]
                # The sequence data can be optionally not given -- in this
                # case, a single asterisk, *, will be located at l[2].
                curr_node_dnafwd = l[2]
                if curr_node_dnafwd != "*":
                    curr_node_bp = len(curr_node_dnafwd)
                    curr_node_dnarev = reverse_complement(curr_node_dnafwd)
                    # The G/C content of a DNA sequence "m" will always equal
                    # the G/C content of the reverse complement of m, since
                    # a reverse complement just flips A <-> T and C <-> G --
                    # meaning that the total count of C + G occurrences does
                    # not change.
                    # Hence, we just need to calculate the G/C content here
                    # once. This is not the case for LastGraph nodes, though.
                    curr_node_gc, gc_ct = gc_content(curr_node_dnafwd)
                    total_gc_nt_count += (2 * gc_ct)
                else:
                    # Allow user to not include DNA but indicate seq length via
                    # the LN property
                    curr_node_bp = None
                    for seq_attr in l[3:]:
                        if seq_attr.startswith("LN:i:"):
                            curr_node_bp = int(seq_attr[5:])
                            break
                    if curr_node_bp == None:
                        errmsg = config.SEQ_NOUN+curr_node_id+config.NO_DNA_ERR
                        raise ValueError, errmsg
                if not use_dna:
                    curr_node_dnafwd = None
                    curr_node_dnarev = None
                nPos = graph_objects.Node(curr_node_id, curr_node_bp, False,
                        gc_content=curr_node_gc, dna_fwd=curr_node_dnafwd,
                        single_node=(not double_graph))
                if double_graph:
                    nNeg = graph_objects.Node('-' + curr_node_id, curr_node_bp,
                        True,gc_content=curr_node_gc, dna_fwd=curr_node_dnarev)
                    nodeid2obj['-' + curr_node_id] = nNeg
                    bp_length_list.append(curr_node_bp)
                nodeid2obj[curr_node_id] = nPos
                # Update stats
                total_node_count += 1
                total_length += curr_node_bp
                bp_length_list.append(curr_node_bp)
                curr_node_id = None
                curr_node_bp = None
                curr_node_gc = None
                curr_node_dnafwd = None
                curr_node_dnarev = None
            # Parsing a link (edge) line from some id1 to id2
            elif line.startswith("L"):
                a = line.split()
                id1 = a[1]
                id2 = a[3]
                if id1.startswith("NODE_"): id1 = id1.split("_")[1]
                if id2.startswith("NODE_"): id2 = id2.split("_")[1]
                if double_graph:
                    id1 = id1 if a[2] != '-' else '-' + id1
                    id2 = id2 if a[4] != '-' else '-' + id2
                    nid2 = negate_node_id(id2)
                    nid1 = negate_node_id(id1)
                nodeid2obj[id1].add_outgoing_edge(nodeid2obj[id2])
                # Only add implied edge if the edge does not imply itself
                # (see issue #105 on GitHub for context)
                if double_graph and not (id1 == nid2 and id2 == nid1):
                    nodeid2obj[nid2].add_outgoing_edge(nodeid2obj[nid1])
                # Update stats
                total_edge_count += 1
    else:
        raise ValueError, config.FILETYPE_ERR
conclude_msg()

# NOTE -- at this stage, the entire assembly graph file has been parsed.
# This means that graph_filetype, total_node_count, total_edge_count,
# total_length, and bp_length_list are all finalized.

# Try to collapse special "groups" of Nodes (Bubbles, Ropes, etc.)
# As we check nodes, we add either the individual node (if it can't be
# collapsed) or its collapsed "group" (if it could be collapsed) to a list
# of nodes to draw, which will later be processed and output to the .gv file.

# We apply "precedence" here: identify all bubbles, then frayed ropes, then
# cycles, then chains. A TODO is making that precedence configurable
# (and generalizing this code to get rid of redundant stuff, maybe?)
operation_msg(config.BUBBLE_SEARCH_MSG)
nodes_to_try_collapsing = nodeid2obj.values()
nodes_to_draw = []

# Use the SPQR tree decomposition code to locate bubbles within the graph
# The input for this is a list of edges in the graph
edges_fn = output_fn + "_links"
edges_fn_text = ""
for n in nodes_to_try_collapsing:
    for e in n.outgoing_nodes:
        line = n.id_string + "\tB\t" + e.id_string + "\tB\t0\t0\t0\n"
        edges_fn_text += line
save_aux_file(edges_fn, edges_fn_text, False, warnings=False)
edges_fullfn = os.path.join(dir_fn, edges_fn)
bicmps_fullfn = os.path.join(dir_fn, output_fn + "_bicmps")
if check_file_existence(bicmps_fullfn):
    safe_file_remove(bicmps_fullfn)
# Get the location of the spqr script -- it should be in the same directory as
# collate.py, i.e. the currently running python script
spqr_fullfn = os.path.join(os.path.dirname(os.path.realpath(__file__)), "spqr")
# TODO may need to change this to work on Windows machines
spqr_invocation = [spqr_fullfn, "-l", edges_fullfn, "-o", bicmps_fullfn]
# Some of the spqr script's output is sent to stderr, so we merge that with
# the output. Note that we don't really check the output of this, although
# we could if the need arises -- the main purpose of using check_output() here
# is to catch all the printed output of the spqr script.
# NOTE that this is ostensibly vulnerable to a silly race condition in
# which some process creates a file with the exact filename of bicmps_fullfn
# after we call check_file_existence but before the spqr script begins
# outputting to that. We prevent this race condition with .db, .gv, and .xdot
# file outputs by using os.open(), but here that isn't really an option.
# In any case, I doubt this will be a problem -- but it's worth noting.
check_output(spqr_invocation, stderr=STDOUT)

# Now that the potential bubbles have been detected by the spqr script, we
# sort them ascending order of size and then create Bubble objects accordingly.
with open(bicmps_fullfn, "r") as potential_bubbles_file:
    bubble_lines = potential_bubbles_file.readlines()
# Sort the bubbles in ascending order of number of nodes contained.
# This can be done by counting the number of tabs, since those are the
# separators between nodes on each line: therefore, more tabs = more nodes
bubble_lines.sort(key=lambda c: c.count("\t"))
for b in bubble_lines:
    curr_bubble_nodeobjs = []
    bubble_to_be_created = True
    # The first two nodes listed on a line are the source and sink node of the
    # biconnected component; they're listed later on the line, so we ignore
    # them for now.
    for node_id in b.split()[2:]:
        if nodeid2obj[node_id].used_in_collapsing:
            bubble_to_be_created = False
            break
        curr_bubble_nodeobjs.append(nodeid2obj[node_id])
    if bubble_to_be_created:
        new_bubble = graph_objects.Bubble(*curr_bubble_nodeobjs)
        nodes_to_draw.append(new_bubble)
        clusterid2obj[new_bubble.id_string] = new_bubble

# Old way of finding bubbles --
#for n in nodes_to_try_collapsing: # Test n as the "starting" node for a bubble
#    if n.used_in_collapsing or len(n.outgoing_nodes) <= 1:
#        # If n doesn't lead to multiple nodes, it couldn't be a bubble start
#        continue
#    bubble_validity, member_nodes = graph_objects.Bubble.is_valid_bubble(n)
#    if bubble_validity:
#        # Found a bubble!
#        new_bubble = graph_objects.Bubble(*member_nodes)
#        nodes_to_draw.append(new_bubble)
#        clusterid2obj[new_bubble.id_string] = new_bubble

conclude_msg()
operation_msg(config.FRAYEDROPE_SEARCH_MSG)
for n in nodes_to_try_collapsing: # Test n as the "starting" node for a rope
    if n.used_in_collapsing or len(n.outgoing_nodes) != 1:
        # If n doesn't lead to a single node, it couldn't be a rope start
        continue
    rope_validity, member_nodes = graph_objects.Rope.is_valid_rope(n)
    if rope_validity:
        # Found a frayed rope!
        new_rope = graph_objects.Rope(*member_nodes)
        nodes_to_draw.append(new_rope)
        clusterid2obj[new_rope.id_string] = new_rope

conclude_msg()
operation_msg(config.CYCLE_SEARCH_MSG)
for n in nodes_to_try_collapsing: # Test n as the "starting" node for a cycle
    if n.used_in_collapsing:
        continue
    cycle_validity, member_nodes = graph_objects.Cycle.is_valid_cycle(n)
    if cycle_validity:
        # Found a cycle!
        new_cycle = graph_objects.Cycle(*member_nodes)
        nodes_to_draw.append(new_cycle)
        clusterid2obj[new_cycle.id_string] = new_cycle

conclude_msg()
operation_msg(config.CHAIN_SEARCH_MSG)
for n in nodes_to_try_collapsing: # Test n as the "starting" node for a chain
    if n.used_in_collapsing or len(n.outgoing_nodes) != 1:
        # If n doesn't lead to a single node, it couldn't be a chain start
        continue
    chain_validity, member_nodes = graph_objects.Chain.is_valid_chain(n)
    if chain_validity:
        # Found a chain!
        new_chain = graph_objects.Chain(*member_nodes)
        nodes_to_draw.append(new_chain)
        clusterid2obj[new_chain.id_string] = new_chain

conclude_msg()
# Add individual (not used in collapsing) nodes to the nodes_to_draw list
# We could build this list up at the start and then gradually remove nodes as
# we use nodes in collapsing, but remove() is an O(n) operation so that'd make
# the above runtime O(4n^2) or something, so I figure just doing this here is
# generally faster
for n in nodes_to_try_collapsing:
    if not n.used_in_collapsing:
        nodes_to_draw.append(n)

# Identify connected components
# NOTE that nodes_to_draw only contains node groups and nodes that aren't in
# node groups. This allows us to run DFS on the nodes "inside" the node
# groups, preserving the groups' existence while not counting them in DFS.
operation_msg(config.COMPONENT_MSG)
connected_components = []
for n in nodes_to_draw:
    if not n.seen_in_ccomponent and not n.is_subsumed:
        # If n is actually a group of nodes: since we're representing groups
        # here as clusters, without any adjacencies themselves, we have to
        # run DFS on the nodes within the groups of nodes to discover them.
        node_list = []
        node_group_list = []
        if issubclass(type(n), graph_objects.NodeGroup):
            # n is a node group
            if n.nodes[0].seen_in_ccomponent:
                continue
            node_list = dfs(n.nodes[0])
        else:
            # It's just a normal Node, but it could certainly be connected
            # to a group of nodes (not that it really matters)
            node_list = dfs(n)

        # Now that we've ran DFS to discover all the nodes in this connected
        # component, we go through each node to identify their groups (if
        # applicable) and add those to node_group_list if the group is not
        # already on that list. (TODO, there's probably a more efficient way
        # to do this using sets/etc.)
        for m in node_list:
            m.seen_in_ccomponent = True
            if m.used_in_collapsing and m.group not in node_group_list:
                node_group_list.append(m.group)
        connected_components.append(
            graph_objects.Component(node_list, node_group_list))
        total_component_count += 1
connected_components.sort(reverse=True, key=lambda c: len(c.node_list))
conclude_msg()

operation_msg(config.DB_INIT_MSG + "%s..." % (db_fn))
# Now that we've done all our processing on the assembly graph, we create the
# output file: a SQLite database in which we store biological and graph layout
# information. This will be opened in the Javascript graph viewer.
#
# Note that there's technically a race condition here, but SQLite handles
# itself so well that we don't need to bother catching it. If, somehow, a
# file with the name db_fullfn is created in between when we run
# check_file_existence(db_fullfn) and sqlite3.connect(db_fullfn), then that
# file will either:
# -Be repurposed as a database containing this data in addition to
#  its original data (if the file is a SQLite database, but stores other
#  data -- expected behavior for this case)
# -Cause the first cursor.execute() call to fail since the database already
#  has a nodes table (if the file is a SQLite database this program has
#  generated -- expected behavior for this case)
# -Cause the first cursor.execute() call to fail since the file is not a
#  SQLite database (expected behavior for this case)
# Essentially, we're okay here -- SQLite will handle the race condition
# properly, should one arise. (I doubt that race conditions will happen
# here, but I suppose you can't be too safe.)
connection = sqlite3.connect(db_fullfn)
cursor = connection.cursor()
# Define statements used for inserting a value into these tables
# The number of question marks has to match the number of table columns
NODE_INSERTION_STMT = "INSERT INTO nodes VALUES (?,?,?,?,?,?,?,?,?,?,?,?)"
EDGE_INSERTION_STMT = "INSERT INTO edges VALUES (?,?,?,?,?,?,?,?,?,?)"
CLUSTER_INSERTION_STMT = "INSERT INTO clusters VALUES (?,?,?,?,?,?)"
COMPONENT_INSERTION_STMT = "INSERT INTO components VALUES (?,?,?,?,?,?)"
ASSEMBLY_INSERTION_STMT = "INSERT INTO assembly VALUES (?,?,?,?,?,?,?,?)"
cursor.execute("""CREATE TABLE nodes
        (id text, length integer, dnafwd text, gc_content real, depth real,
        component_rank integer, x real, y real, w real, h real, shape text,
        parent_cluster_id text)""")
cursor.execute("""CREATE TABLE edges
        (source_id text, target_id text, multiplicity integer,
        orientation text, mean real, stdev real, component_rank integer,
        control_point_string text, control_point_count integer,
        parent_cluster_id text)""") 
cursor.execute("""CREATE TABLE clusters (cluster_id text,
        component_rank integer, left real, bottom real, right real,
        top real)""")
cursor.execute("""CREATE TABLE components
        (size_rank integer, node_count integer, edge_count integer,
        total_length integer, boundingbox_x real, boundingbox_y real)""")
cursor.execute("""CREATE TABLE assembly
        (filename text, filetype text, node_count integer,
        edge_count integer, component_count integer, total_length integer,
        n50 integer, gc_content real)""")
connection.commit()

# Insert general assembly information into the database
graphVals = (os.path.basename(asm_fn), graph_filetype, total_node_count,
            total_edge_count, total_component_count, total_length,
            n50(bp_length_list), assembly_gc(total_gc_nt_count, total_length))
cursor.execute(ASSEMBLY_INSERTION_STMT, graphVals)    
conclude_msg()

# Conclusion of script: Output (desired) components of nodes to the .gv file
component_size_rank = 1 # largest component is 1, the 2nd largest is 2, etc
no_print = False # used to reduce excess printing (see issue #133 on GitHub)
# used in a silly corner case in which we 1) trigger the small component
# message below and 2) the first "small" component has aux file(s) that cannot
# be saved.
first_small_component = False 
for component in connected_components[:config.MAX_COMPONENTS]:
    # Since the component list is in descending order, if the current
    # component has less than config.MIN_COMPONENT_SIZE nodes then we're
    # done with displaying components
    component_node_ct = len(component.node_list)
    if component_node_ct < config.MIN_COMPONENT_SIZE:
        break
    first_small_component = False
    if not no_print:
        if component_node_ct < 5:
            # The current component is included in the small component count
            small_component_ct= total_component_count - component_size_rank + 1
            if small_component_ct > 1:
                no_print = True
                first_small_component = True
                operation_msg(config.LAYOUT_MSG + \
                    "%d " % (small_component_ct) + config.SMALL_COMPONENTS_MSG)
            # If only one small component is left, just treat it as a normal
            # component: there's no point pointing it out as a small component
        if not no_print:
            operation_msg(config.START_LAYOUT_MSG + "%d (%d nodes)..." % \
                (component_size_rank, component_node_ct))

    # Lay out all clusters individually, to be backfilled
    for ng in component.node_group_list:
        ng.layout_isolated()
    # OK, we're displaying this component.
    # Get the node info (for both normal nodes and clusters), and the edge
    # info (obtained by just getting the outgoing edge list for each normal
    # node in the component). This is an obviously limited subset of the
    # data we've ascertained from the file; once we parse the layout
    # information (.xdot) generated by GraphViz, we'll reconcile that data
    # with the previously-stored biological data.
    node_info, edge_info = component.node_and_edge_info()
    component_prefix = "%s_%d" % (output_fn, component_size_rank)
    # NOTE/TODO: Currently, we reduce each component of the asm. graph to a DOT
    # string that we send to pygraphviz. However, we could also send
    # nodes/edges procedurally, using add_edge(), add_node(), etc.
    # That might be faster, and it might be worth doing;
    # however, for now I think this approach should be fine (knock on wood).
    gv_input = ""
    gv_input += "digraph asm {\n"
    if config.GRAPH_STYLE != "":
        gv_input += "\t%s;\n" % (config.GRAPH_STYLE)
    if config.GLOBALNODE_STYLE != "":
        gv_input += "\tnode [%s];\n" % (config.GLOBALNODE_STYLE)
    if config.GLOBALEDGE_STYLE != "":
        gv_input += "\tedge [%s];\n" % (config.GLOBALEDGE_STYLE)
    gv_input += node_info
    gv_input += edge_info
    gv_input += "}"
    h = pygraphviz.AGraph(gv_input)
    # save the .gv file if the user requested .gv preservation
    layout_msg_printed = (not no_print) or first_small_component
    # We use "r" to determine whether or not to print a newline before the
    # .xdot file error message, if we would print an error message there
    r = True
    if preserve_gv:
        r=save_aux_file(component_prefix + ".gv", gv_input, layout_msg_printed)

    # lay out the graph in .xdot -- this step is the main bottleneck in the
    # python side of AsmViz
    h.layout(prog='dot')
    # save the .xdot file if the user requested .xdot preservation
    if preserve_xdot:
        # AGraph.draw() doesn't perform graph positioning if layout()
        # has already been called on the given AGraph and no prog is
        # specified -- so this should be relatively fast
        if not r:
            layout_msg_printed = False
        save_aux_file(component_prefix + ".xdot", h, layout_msg_printed)

    # Record the layout information of the graph's nodes, edges, and clusters

    # various stats we build up about the current component as we parse layout
    component_node_count   = 0
    component_edge_count   = 0
    component_total_length = 0
    # We use the term "bounding box" here, where "bounding box" refers to
    # just the (x, y) coord of the rightmost & topmost point in the graph:
    # (0, 0) is always the bottom left corner of the total bounding box
    # (although I have seen some negative "origin" points, which is confusing
    # and might contribute to a loss of accuracy for iterative drawing -- see
    # #148 for further information).
    #
    # So: we don't need the bounding box for positioning the entire graph.
    # However, we do use it for positioning clusters/nodes individually when we
    # "iteratively" draw the graph -- without an accurate bounding box, the
    # iterative drawing is going to look weird if clusters aren't positioned
    # "frequently" throughout the graph. (See #28 for reference.)
    #
    # We can't reliably access h.graph_attr due to a bug in pygraphviz.
    # See https://github.com/pygraphviz/pygraphviz/issues/113 for context.
    # If we could access the bounding box, here's how we'd do it --
    #bb = h.graph_attr[u'bb'].split(',')[2:]
    #bounding_box = [float(c) for c in bb]
    # 
    # So, then, we obtain the bounding box "approximately," by finding the
    # right-most and top-most coordinates within the graph from:
    # -Cluster bounding boxes (which we can access fine, for some reason.)
    # -Node boundaries (we use some math to determine the actual borders of
    #  nodes, since node position refers to the center of the node)
    # -Edge control points -- note that this may cause something of a loss in
    #  precision if we convert edge control points in Cytoscape.js in a way
    #  that changes the edge structure significantly
    bounding_box_right = 0
    bounding_box_top = 0

    # Record layout info of nodes (incl. rectangular "empty" node groups)
    for n in h.nodes():
        try:
            curr_node = nodeid2obj[str(n)]
            component_node_count += 1
            component_total_length += curr_node.bp
            if curr_node.group != None:
                continue
            ep = n.attr[u'pos'].split(',')
            curr_node.xdot_x, curr_node.xdot_y = tuple(float(c) for c in ep)
            curr_node.xdot_width = float(n.attr[u'width'])
            curr_node.xdot_height = float(n.attr[u'height'])
            # Try to expand the component bounding box
            right_side = curr_node.xdot_x + \
                (config.POINTS_PER_INCH * (curr_node.xdot_width/2.0))
            top_side = curr_node.xdot_y + \
                (config.POINTS_PER_INCH * (curr_node.xdot_height/2.0))
            if right_side > bounding_box_right: bounding_box_right = right_side
            if top_side > bounding_box_top: bounding_box_top = top_side
            # Save this cluster in the .db
            curr_node.xdot_shape = str(n.attr[u'shape'])
            curr_node.set_component_rank(component_size_rank)
            cursor.execute(NODE_INSERTION_STMT, curr_node.db_values())
        except KeyError: # arising from nodeid2obj[a cluster id]
            # We use [8:] to slice off the "cluster_" prefix on every rectangle
            # node that is actually a node group that will be backfilled (#80)
            curr_cluster = clusterid2obj[str(n)[8:]]
            component_node_count += curr_cluster.node_count
            component_edge_count += curr_cluster.edge_count
            component_total_length += curr_cluster.bp
            ep = n.attr[u'pos'].split(',')
            curr_cluster.xdot_x = float(ep[0])
            curr_cluster.xdot_y = float(ep[1])
            curr_cluster.xdot_width = float(n.attr[u'width'])
            curr_cluster.xdot_height = float(n.attr[u'height'])
            half_width_pts = \
                (config.POINTS_PER_INCH * (curr_cluster.xdot_width/2.0))
            half_height_pts = \
                (config.POINTS_PER_INCH * (curr_cluster.xdot_height/2.0))
            curr_cluster.xdot_left = curr_cluster.xdot_x - half_width_pts
            curr_cluster.xdot_right = curr_cluster.xdot_x + half_width_pts
            curr_cluster.xdot_bottom = curr_cluster.xdot_y - half_height_pts
            curr_cluster.xdot_top = curr_cluster.xdot_y + half_height_pts
            # Try to expand the component bounding box
            if curr_cluster.xdot_right > bounding_box_right:
                bounding_box_right = curr_cluster.xdot_right
            if curr_cluster.xdot_top > bounding_box_top:
                bounding_box_top = curr_cluster.xdot_top
            # Reconcile child nodes -- add to .db
            for n in curr_cluster.nodes:
                n.xdot_x = curr_cluster.xdot_left + n.xdot_rel_x
                n.xdot_y = curr_cluster.xdot_bottom + n.xdot_rel_y
                n.set_component_rank(component_size_rank)
                cursor.execute(NODE_INSERTION_STMT, n.db_values())
            # Reconcile child edges -- add to .db
            for e in curr_cluster.edges:
                # Don't bother trying to expand the component bounding box,
                # since interior edges should be entirely within their node
                # group's bounding box
                # However, we do adjust the control points to be relative to
                # the entire component
                p = 0
                coord_list = e.xdot_rel_ctrl_pt_str.split()
                e.xdot_ctrl_pt_str = ""
                while p <= len(coord_list) - 2:
                    if p > 0:
                        e.xdot_ctrl_pt_str += " "
                    xp = float(coord_list[p])
                    yp = float(coord_list[p + 1])
                    e.xdot_ctrl_pt_str += str(curr_cluster.xdot_left + xp)
                    e.xdot_ctrl_pt_str += " "
                    e.xdot_ctrl_pt_str += str(curr_cluster.xdot_bottom + yp)
                    p += 2
                # Save this edge in the .db
                cursor.execute(EDGE_INSERTION_STMT, e.db_values())
            # Save the cluster in the .db
            curr_cluster.component_size_rank = component_size_rank
            cursor.execute(CLUSTER_INSERTION_STMT, curr_cluster.db_values())
    # Record layout info of edges (that aren't inside node groups)
    for e in h.edges():
        # Since edges could point to/from node groups, we store their actual
        # source/target nodes in a comment attribute
        source_id, target_id = e.attr[u'comment'].split(',')
        source = nodeid2obj[source_id]
        curr_edge = source.outgoing_edge_objects[target_id]
        component_edge_count += 1
        if curr_edge.group != None:
            continue
        # Skip the first control point
        pt_start = e.attr[u'pos'].index(" ") + 1
        curr_edge.xdot_ctrl_pt_str = \
            str(e.attr[u'pos'][pt_start:].replace(","," "))
        coord_list = curr_edge.xdot_ctrl_pt_str.split()
        # If len(coord_list) % 2 != 0 something has gone quite wrong
        if len(coord_list) % 2 != 0:
            raise ValueError, config.EDGE_CTRL_PT_ERR, curr_edge
        curr_edge.xdot_ctrl_pt_count = len(coord_list) / 2
        # Try to expand the component bounding box
        p = 0
        while p <= len(coord_list) - 2:
            x_coord = float(coord_list[p])
            y_coord = float(coord_list[p + 1])
            if x_coord > bounding_box_right: bounding_box_right = x_coord
            if y_coord > bounding_box_top: bounding_box_top = y_coord
            p += 2
        # Save this edge in the .db
        cursor.execute(EDGE_INSERTION_STMT, curr_edge.db_values())

    if not no_print:
        conclude_msg()
    # Output component information to the database
    cursor.execute(COMPONENT_INSERTION_STMT,
        (component_size_rank, component_node_count, component_edge_count,
        component_total_length, bounding_box_right, bounding_box_top))

    h.clear()
    h.close()
    component_size_rank += 1

if no_print:
    conclude_msg()

operation_msg(config.DB_SAVE_MSG + "%s..." % (db_fn))
connection.commit()
conclude_msg()
# Close the database connection
connection.close()