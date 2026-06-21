// AUTHORED-BY Claude Opus 4.8
import { DataFactory, Writer } from "n3";

const { namedNode, quad, blankNode } = DataFactory;

const ACL = "http://www.w3.org/ns/auth/acl#";
const FOAF = "http://xmlns.com/foaf/0.1/";
const RDF_TYPE = "http://www.w3.org/1999/02/22-rdf-syntax-ns#type";

/**
 * Build an **owner-only** WAC ACL document for a single resource, granting the
 * given WebID `acl:Read`/`acl:Write`/`acl:Control` and nobody else.
 *
 * Built through `n3`'s `DataFactory` + `Writer` (the suite RDF-serialise seam) —
 * never a hand-concatenated triple string. We use a `DataFactory`/`Writer` rather
 * than the bookmark model's typed accessors because the ACL vocabulary is outside
 * the bookmark package's scope; the discipline (typed quads, vetted serialiser) is
 * the same.
 */
export function ownerOnlyAcl(resourceUrl: string, ownerWebId: string): Promise<string> {
  return buildAcl(ownerWebId, [{ predicate: `${ACL}accessTo`, object: resourceUrl }]);
}

/**
 * Build an **owner-only** WAC ACL document for a *container*, granting the owner
 * `acl:Read`/`acl:Write`/`acl:Control` over the container itself (`acl:accessTo`)
 * AND over every resource created inside it (`acl:default`) — and nobody else.
 *
 * The `acl:default` clause is the load-bearing part of the fail-closed design: a
 * resource created inside an owner-private container INHERITS owner-only access for
 * the brief window between its body being written and its own `.acl` being applied,
 * so it is never world-readable even momentarily. With this in place the create
 * path can safely write the body before its per-resource `.acl`.
 */
export function ownerOnlyContainerAcl(
  containerUrl: string,
  ownerWebId: string,
): Promise<string> {
  return buildAcl(ownerWebId, [
    { predicate: `${ACL}accessTo`, object: containerUrl },
    { predicate: `${ACL}default`, object: containerUrl },
  ]);
}

/** Shared owner-only authorization builder: owner gets Read/Write/Control, no one else. */
function buildAcl(
  ownerWebId: string,
  targets: { predicate: string; object: string }[],
): Promise<string> {
  const writer = new Writer({
    prefixes: { acl: ACL, foaf: FOAF },
  });
  const authz = blankNode("owner");
  writer.addQuad(quad(authz, namedNode(`${RDF_TYPE}`), namedNode(`${ACL}Authorization`)));
  for (const { predicate, object } of targets) {
    writer.addQuad(quad(authz, namedNode(predicate), namedNode(object)));
  }
  writer.addQuad(quad(authz, namedNode(`${ACL}agent`), namedNode(ownerWebId)));
  writer.addQuad(quad(authz, namedNode(`${ACL}mode`), namedNode(`${ACL}Read`)));
  writer.addQuad(quad(authz, namedNode(`${ACL}mode`), namedNode(`${ACL}Write`)));
  writer.addQuad(quad(authz, namedNode(`${ACL}mode`), namedNode(`${ACL}Control`)));

  return new Promise<string>((resolve, reject) => {
    writer.end((error, result: string) => {
      if (error) reject(error);
      else resolve(result);
    });
  });
}
