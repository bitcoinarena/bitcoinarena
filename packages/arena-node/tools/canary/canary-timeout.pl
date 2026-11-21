#!/usr/bin/perl
# kanban #2905: canary-timeout.pl SECONDS LOCKFILE [--wait] CMD ARGS... - run CMD in its own process group under an exclusive lock on
# LOCKFILE (busy: exit 75, or wait with --wait); after SECONDS the whole group (node + Chrome) gets TERM, then KILL. Exit = CMD's exit.
# (macOS has no timeout/flock; perl -e 'alarm' alone would leave Chrome running.)
use strict; use Fcntl qw(:flock);
my ($secs, $lockf) = (shift, shift); my $wait = 0; if (@ARGV && $ARGV[0] eq '--wait') { $wait = 1; shift; }
open(my $lk, '>>', $lockf) or die "#2905 lock $lockf: $!";
unless (flock($lk, LOCK_EX | ($wait ? 0 : LOCK_NB))) { print "#2905 busy: another canary pass holds $lockf\n"; exit 75; }
my $pid = fork(); die "#2905 fork: $!" unless defined $pid;
if ($pid == 0) { close($lk); setpgrp(0, 0); exec(@ARGV) or die "#2905 exec: $!"; }
my $timed = 0;
local $SIG{ALRM} = sub { $timed = 1; kill('TERM', -$pid); sleep 5; kill('KILL', -$pid); };
alarm($secs);
my $r; do { $r = waitpid($pid, 0); } while ($r == -1 && $!{EINTR});
my $st = $?; alarm(0);
if ($timed) { print "#2905 timeout after ${secs} s: the run's process group was killed\n"; exit 124; }
exit($st & 127 ? 128 + ($st & 127) : $st >> 8);
