// AUTHORED-BY Claude Opus 4.8
import { DataFactory, Writer } from "n3";

const { namedNode, quad, blankNode } = DataFactory;

const ACL = "http://www.w3.org/ns/auth/acl#";
const FOAF = "http://xmlns.com/foaf/0.1/";
const RDF_TYPE = "http://www.w3.org/1999/02/22-rdf-syntax-ns#type";

/**
 * Build an **owner-only** WAC ACL document for a resource, granting the given
 * WebID `acl:Read`/`acl:Write`/`acl:Control` and nobody else.
 *
 * Built through `n3`'s `DataFactory` + `Writer` (the suite RDF-serialise seam) —
 * never a hand-concatenated triple string. We use a `DataFactory`/`Writer` rather
 * than the bookmark model's typed accessors because the ACL vocabulary is outside
 * the bookmark package's scope; the discipline (typed quads, vetted serialiser) is
 * the same.
 *
 * The ACL is written FIRST (before the resource body) so the bookmark is never
 * briefly world-readable.
 */
export function ownerOnlyAcl(resourceUrl: string, ownerWebId: string): Promise<string> {
  const writer = new Writer({
    prefixes: { acl: ACL, foaf: FOAF },
  });
  const authz = blankNode("owner");
  writer.addQuad(quad(authz, namedNode(`${RDF_TYPE}`), namedNode(`${ACL}Authorization`)));
  writer.addQuad(quad(authz, namedNode(`${ACL}accessTo`), namedNode(resourceUrl)));
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
